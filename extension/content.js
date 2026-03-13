// Meet Recorder — call detection content script
// Polls for join/leave state on meet.google.com

(function meetRecorderDetection() {
  const POLL_INTERVAL_MS = 2000;
  let inCall = false;

  // --- Toast notification system ---

  function injectStyles() {
    if (document.getElementById("meet-recorder-styles")) return;
    const style = document.createElement("style");
    style.id = "meet-recorder-styles";
    style.textContent = `
      .meet-recorder-toast {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 999999;
        padding: 12px 24px;
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 14px;
        font-weight: 600;
        color: white;
        box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
      }
      .meet-recorder-toast.visible { opacity: 1; pointer-events: auto; }
      .meet-recorder-toast.success { background: #16a34a; }
      .meet-recorder-toast.error { background: #dc2626; }
      .meet-recorder-toast.warning { background: #d97706; }

      .meet-recorder-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        z-index: 999998;
        background: rgba(0,0,0,0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
      }
      .meet-recorder-overlay.visible { opacity: 1; pointer-events: auto; }
      .meet-recorder-overlay-box {
        background: white;
        border-radius: 12px;
        padding: 28px 36px;
        max-width: 440px;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 8px 40px rgba(0,0,0,0.3);
      }
      .meet-recorder-overlay-box h2 {
        margin: 0 0 12px;
        font-size: 18px;
        color: #dc2626;
      }
      .meet-recorder-overlay-box p {
        margin: 0 0 20px;
        font-size: 14px;
        color: #374151;
        line-height: 1.5;
      }
      .meet-recorder-overlay-box code {
        background: #f3f4f6;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 13px;
      }
      .meet-recorder-overlay-box .btn-row {
        display: flex;
        gap: 12px;
        justify-content: center;
      }
      .meet-recorder-overlay-box button {
        padding: 10px 20px;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      .meet-recorder-overlay-box .btn-retry {
        background: #2563eb;
        color: white;
      }
      .meet-recorder-overlay-box .btn-retry:hover { background: #1d4ed8; }
      .meet-recorder-overlay-box .btn-dismiss {
        background: #e5e7eb;
        color: #374151;
      }
      .meet-recorder-overlay-box .btn-dismiss:hover { background: #d1d5db; }
    `;
    document.head.appendChild(style);
  }

  function showToast(message, type = "success", durationMs = 4000) {
    injectStyles();
    const toast = document.createElement("div");
    toast.className = `meet-recorder-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  function showServerDownOverlay() {
    injectStyles();

    // Remove any existing overlay
    document.querySelector(".meet-recorder-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "meet-recorder-overlay";

    const box = document.createElement("div");
    box.className = "meet-recorder-overlay-box";

    const h2 = document.createElement("h2");
    h2.textContent = "Meet Recorder: server not running";
    box.appendChild(h2);

    const p1 = document.createElement("p");
    p1.textContent = "The recording server isn't responding. Start it manually in a terminal:";
    box.appendChild(p1);

    const p2 = document.createElement("p");
    const code = document.createElement("code");
    code.textContent = "python3 ~/.agents/skills/transcribe-call/server/server.py";
    p2.appendChild(code);
    box.appendChild(p2);

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const retryBtn = document.createElement("button");
    retryBtn.className = "btn-retry";
    retryBtn.textContent = "Retry recording";
    retryBtn.addEventListener("click", () => {
      overlay.classList.remove("visible");
      setTimeout(() => overlay.remove(), 300);
      chrome.runtime.sendMessage({
        type: "meetCallStarted",
        meetingTitle: getMeetingTitle(),
        meetingUrl: window.location.href,
      });
    });
    btnRow.appendChild(retryBtn);

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "btn-dismiss";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => {
      overlay.classList.remove("visible");
      setTimeout(() => overlay.remove(), 300);
    });
    btnRow.appendChild(dismissBtn);

    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("visible"));
  }

  // --- Listen for messages from background script ---

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "recordingStarted") {
      showToast("Recording started", "success");
    } else if (msg.type === "recordingStopped") {
      const text = msg.transcribing
        ? "Recording stopped — transcribing..."
        : "Recording stopped — transcript saved";
      showToast(text, "success", 5000);
    } else if (msg.type === "recordingError") {
      if (msg.serverDown) {
        showServerDownOverlay();
      } else {
        showToast(`Recording failed: ${msg.error}`, "error", 6000);
      }
    }
  });

  // --- Call detection ---

  function isInCall() {
    return !!(
      document.querySelector('[aria-label="Leave call"]') ||
      document.querySelector('[data-tooltip="Leave call"]')
    );
  }

  function getMeetingTitle() {
    return document.title.replace(/ - Google Meet$/, "").trim() || "";
  }

  setInterval(() => {
    const currentlyInCall = isInCall();

    if (!inCall && currentlyInCall) {
      inCall = true;
      console.log("[Meet Recorder] Call started");
      chrome.runtime.sendMessage({
        type: "meetCallStarted",
        meetingTitle: getMeetingTitle(),
        meetingUrl: window.location.href,
      });
    } else if (inCall && !currentlyInCall) {
      inCall = false;
      console.log("[Meet Recorder] Call ended");
      chrome.runtime.sendMessage({ type: "meetCallEnded" });
    }
  }, POLL_INTERVAL_MS);
})();
