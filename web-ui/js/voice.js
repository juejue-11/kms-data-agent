(() => {
  "use strict";

  const ASR_URL = "ws://10.108.13.254:8000/api/v1/asr/stream";
  // 填写能调用当前语音模型的真实 Key。
  const API_KEY = "在这里填写你的语音模型Key";

  // 不需要热词时写成 []。
  const HOTWORDS = [];

  const input = document.getElementById("user-input");
  const send = document.getElementById("send-btn");

  if (!input || !send || document.getElementById("voice-btn")) return;

  const micIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3"/>
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>
        </svg>
    `;

  const stopIcon = `
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
        </svg>
    `;

  // 将录音按钮插入发送按钮左侧。
  const button = document.createElement("button");
  button.id = "voice-btn";
  button.type = "button";
  send.before(button);

  const status = document.createElement("p");
  status.id = "voice-status";
  status.setAttribute("role", "status");
  input.closest(".input-area").after(status);


  let session = null;

  function showStatus(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }

  function paint(state) {
    button.dataset.state = state;
    button.disabled = state === "starting" || state === "stopping";

    const recording = state === "recording";
    const label = recording ? "停止录音" : "开始录音";

    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(recording));
    button.innerHTML = recording ? stopIcon : micIcon;
  }

  function writeText(current, draft = "") {
    const text = [...current.sentences.values(), draft]
      .filter(Boolean)
      .join("");

    input.value = current.prefix + text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function releaseAudio(current) {
    if (current.processor) {
      current.processor.onaudioprocess = null;
      current.processor.disconnect();
    }

    if (current.source) current.source.disconnect();

    if (current.stream) {
      current.stream.getTracks().forEach(track => track.stop());
    }

    if (current.context) {
      void current.context.close().catch(() => { });
    }

    current.processor = null;
    current.source = null;
    current.stream = null;
    current.context = null;
  }

  function finish(current, message, error = false) {
    if (session !== current) return;

    session = null;
    clearTimeout(current.timer);
    releaseAudio(current);

    if (current.ws) current.ws.close();

    // 异常结束时仅保留已确定文字，不把临时草稿当成最终结果。
    writeText(current);
    input.readOnly = current.readOnly;
    delete document.body.dataset.voiceBusy;

    paint("idle");
    showStatus(message, error);


  }

  function beginAudio(current) {
    const context = current.context;

    current.source = context.createMediaStreamSource(current.stream);
    current.processor = context.createScriptProcessor(4096, 1, 1);

    let samples = [];
    let position = 0;

    current.processor.onaudioprocess = event => {
      if (session !== current || current.state !== "recording") return;

      if (current.ws.bufferedAmount > 320000) {
        finish(current, "网络发送积压，请检查网络后重新录音。", true);
        return;
      }

      // 连续重采样为 16kHz，保留跨音频块的采样位置。
      samples.push(...event.inputBuffer.getChannelData(0));

      const pcm = [];

      while (position + 1 < samples.length) {
        const index = Math.floor(position);
        const fraction = position - index;

        const sample =
          samples[index] * (1 - fraction) +
          samples[index + 1] * fraction;

        const value = Math.max(-1, Math.min(1, sample));

        pcm.push(Math.round(value * (value < 0 ? 32768 : 32767)));
        position += context.sampleRate / 16000;
      }

      const consumed = Math.min(
        Math.floor(position),
        samples.length - 1
      );

      samples = samples.slice(consumed);
      position -= consumed;

      // 编码为 16bit、小端、单声道 PCM。
      const buffer = new ArrayBuffer(pcm.length * 2);
      const view = new DataView(buffer);

      pcm.forEach((value, index) => {
        view.setInt16(index * 2, value, true);
      });

      try {
        for (let offset = 0; offset < buffer.byteLength; offset += 6400) {
          current.ws.send(buffer.slice(offset, offset + 6400));
        }
      } catch {
        finish(current, "音频发送失败，请重新录音。", true);
      }
    };

    current.source.connect(current.processor);
    current.processor.connect(context.destination);
  }

  async function startRecording() {
    const state = window.PcbClientController?.state;

    if (
      input.disabled ||
      state?.activeRequest ||
      state?.loadingSession ||
      state?.creatingSession ||
      state?.deletingSessionId
    ) {
      showStatus("请等待当前操作结束后再录音。", true);
      return;
    }

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      showStatus("录音需要 HTTPS 或本机 localhost 页面。", true);
      return;
    }

    if (location.protocol === "https:" && ASR_URL.startsWith("ws:")) {
      showStatus("HTTPS 页面需要 WSS 接口，请先用本机 localhost 测试。", true);
      return;
    }

    const current = {
      prefix: input.value,
      readOnly: input.readOnly,
      sentences: new Map(),
      state: "starting",
      timer: null,
      ws: null,
      stream: null,
      context: null,
      source: null,
      processor: null
    };

    session = current;
    input.readOnly = true;
    document.body.dataset.voiceBusy = "true";

    paint("starting");
    showStatus("正在准备麦克风并连接语音服务…");

    current.timer = setTimeout(() => {
      finish(current, "启动超时，请检查权限、服务器网络和 Key。", true);
    }, 30000);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
        video: false
      });

      if (session !== current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      current.stream = stream;
      current.context = new AudioContext();

      await current.context.resume();
      if (session !== current) return;

      const ws = new WebSocket(ASR_URL);
      current.ws = ws;

      ws.onopen = () => {
        if (session !== current) return;

        ws.send(JSON.stringify({
          action: "start",
          api_key: API_KEY,
          hotwords: HOTWORDS
        }));
      };

      ws.onerror = () => {
        finish(current, "连接失败，请检查服务器 8000 端口是否可访问。", true);
      };

      ws.onclose = () => {
        finish(current, "语音连接已断开，已保留确定文字。", true);
      };

      ws.onmessage = event => {
        if (session !== current) return;

        try {
          const data = JSON.parse(event.data);

          if (data.type === "error") {
            finish(current, `${data.code}：${data.message}`, true);
            return;
          }

          if (
            data.type === "started" &&
            current.state === "starting"
          ) {
            clearTimeout(current.timer);
            current.state = "recording";

            beginAudio(current);
            paint("recording");
            showStatus("正在录音，再次点击按钮停止。");
          }

          if (data.type === "transcript") {
            if (data.stable_text) {
              if (data.sentence_id == null) {
                throw new Error("缺少句子编号");
              }

              current.sentences.set(
                data.sentence_id,
                data.stable_text
              );
            }

            writeText(current, data.unstable_text || "");

            if (data.is_final) {
              finish(current, "识别完成，可编辑文字后点击发送。");
            }
          }
        } catch {
          finish(current, "语音返回数据异常，请重试。", true);
        }
      };
    } catch {
      finish(current, "无法启动录音，请检查麦克风权限和设备。", true);
    }
  }

  function stopRecording() {
    const current = session;
    if (!current || current.state !== "recording") return;

    current.state = "stopping";
    releaseAudio(current);

    paint("stopping");
    showStatus("录音已停止，正在等待最后一句…");

    try {
      current.ws.send(JSON.stringify({ action: "stop" }));

      current.timer = setTimeout(() => {
        finish(current, "等待最终结果超时，已保留确定文字。", true);
      }, 35000);
    } catch {
      finish(current, "停止识别失败，已保留确定文字。", true);
    }
  }

  button.addEventListener("click", () => {
    if (session) {
      stopRecording();
      return;
    }

    if (!API_KEY.trim() || API_KEY === "在这里填写你的语音模型Key") {
      showStatus("请先在 voice.js 顶部填写有效的 API_KEY。", true);
      return;
    }

    void startRecording();
  });
  // 录音和等待最终结果期间，阻止发送及切换会话。
  document.addEventListener("click", event => {
    if (!session) return;

    if (event.target.closest(
      "#send-btn, #new-session-btn, #session-list, .suggestion-card"
    )) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showStatus("请先停止录音并等待完成，再发送或切换会话。");
    }
  }, true);

  input.addEventListener("keydown", event => {
    if (session && event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener("pagehide", () => {
    if (session) finish(session, "录音已取消。");

  });

  paint("idle");
})();
