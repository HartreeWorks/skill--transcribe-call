const SERVER = "http://localhost:7777";
const statusEl = document.getElementById("status");
const meetingTitleEl = document.getElementById("meetingTitle");
const stopBtn = document.getElementById("stopBtn");
const serverDot = document.getElementById("serverDot");
const lastFileEl = document.getElementById("lastFile");

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

async function updateStatus() {
  try {
    const resp = await fetch(`${SERVER}/status`);
    const data = await resp.json();
    serverDot.className = "server-dot online";

    if (data.status === "recording") {
      statusEl.textContent = `Recording · ${formatDuration(data.duration_seconds)}`;
      statusEl.className = "status recording";
      meetingTitleEl.textContent = data.meeting_title || "";
      stopBtn.style.display = "block";
    } else {
      statusEl.textContent = "Idle";
      statusEl.className = "status";
      meetingTitleEl.textContent = "";
      stopBtn.style.display = "none";
    }
  } catch {
    serverDot.className = "server-dot offline";
    statusEl.textContent = "Server offline";
    statusEl.className = "status";
    stopBtn.style.display = "none";
  }

  // Show last recorded file
  const stored = await chrome.storage.local.get(["lastFile", "lastDuration"]);
  if (stored.lastFile) {
    const name = stored.lastFile.split("/").pop();
    lastFileEl.textContent = `Last transcript: ${name}`;
  }
}

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping...";
  chrome.runtime.sendMessage({ type: "stopRecording" });
  setTimeout(updateStatus, 1000);
});

updateStatus();
setInterval(updateStatus, 2000);
