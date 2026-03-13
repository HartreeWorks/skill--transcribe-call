// Meet Recorder — service worker (background script)

const SERVER = "http://localhost:7777";
let recordingTabId = null;

// --- Server communication ---

async function serverFetch(path, options = {}) {
  try {
    const resp = await fetch(`${SERVER}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    return await resp.json();
  } catch (e) {
    console.error(`[Meet Recorder] Server fetch ${path} failed:`, e.message);
    return null;
  }
}

// --- Notify content script ---

function notifyTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Tab might not have content script loaded
  });
}

// --- Badge helpers ---

function setBadgeRecording() {
  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
}

function setBadgeError() {
  chrome.action.setBadgeText({ text: "ERR" });
  chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

// --- Recording lifecycle ---

async function startRecording(meetingTitle, meetingUrl, tabId) {
  const result = await serverFetch("/start", {
    method: "POST",
    body: JSON.stringify({ meeting_title: meetingTitle, meeting_url: meetingUrl }),
  });

  if (!result) {
    // Server unreachable
    setBadgeError();
    notifyTab(tabId, { type: "recordingError", serverDown: true });
    return;
  }

  if (result.error) {
    console.warn("[Meet Recorder] Start failed:", result.error);
    setBadgeError();
    notifyTab(tabId, { type: "recordingError", error: result.error });
    return;
  }

  recordingTabId = tabId;
  await chrome.storage.local.set({
    recording: true,
    recordingTabId: tabId,
    file: result.file,
    startedAt: result.started_at,
    meetingTitle: meetingTitle,
  });

  setBadgeRecording();
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  console.log("[Meet Recorder] Recording started:", result.file);
  notifyTab(tabId, { type: "recordingStarted" });
}

async function stopRecording() {
  chrome.alarms.clear("keepalive");

  const tabId = recordingTabId;
  const result = await serverFetch("/stop", { method: "POST" });

  recordingTabId = null;
  await chrome.storage.local.set({ recording: false, recordingTabId: null });
  clearBadge();

  if (result && !result.error) {
    console.log("[Meet Recorder] Recording stopped:", result.file, `(${result.duration_seconds}s)`);
    await chrome.storage.local.set({ lastFile: result.file, lastDuration: result.duration_seconds });
    notifyTab(tabId, { type: "recordingStopped", transcribing: result.transcribing });
  } else {
    console.warn("[Meet Recorder] Stop result:", result);
  }
}

// --- Recover state on SW startup ---

async function recoverState() {
  const status = await serverFetch("/status");
  if (status && status.status === "recording") {
    const stored = await chrome.storage.local.get(["recordingTabId"]);
    recordingTabId = stored.recordingTabId || null;
    await chrome.storage.local.set({ recording: true });
    setBadgeRecording();
    chrome.alarms.create("keepalive", { periodInMinutes: 1 });
    console.log("[Meet Recorder] Recovered recording state");
  } else {
    await chrome.storage.local.set({ recording: false });
    clearBadge();
  }
}

recoverState();

// --- Message handlers ---

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "meetCallStarted") {
    startRecording(msg.meetingTitle, msg.meetingUrl, sender.tab?.id);
  } else if (msg.type === "meetCallEnded") {
    stopRecording();
  } else if (msg.type === "stopRecording") {
    // Manual stop from popup
    stopRecording();
  }
});

// --- Tab lifecycle ---

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recordingTabId) {
    console.log("[Meet Recorder] Recording tab closed, stopping");
    stopRecording();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === recordingTabId && changeInfo.url) {
    if (!changeInfo.url.startsWith("https://meet.google.com/")) {
      console.log("[Meet Recorder] Recording tab navigated away, stopping");
      stopRecording();
    }
  }
});

// --- Keepalive alarm ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepalive") {
    const status = await serverFetch("/status");
    if (!status || status.status !== "recording") {
      console.log("[Meet Recorder] Recorder no longer running, cleaning up");
      recordingTabId = null;
      await chrome.storage.local.set({ recording: false });
      clearBadge();
      chrome.alarms.clear("keepalive");
    }
  }
});
