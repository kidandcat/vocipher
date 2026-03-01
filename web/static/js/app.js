let ws = null;
let currentChannelID = null;
let isMuted = false;
let reconnectAttempts = 0;

// WebRTC state
let peerConnection = null;
let localStream = null;
let micReady = false;
let pushToTalk = false;
let pttActive = false;

// VAD state
let audioContext = null;
let analyser = null;
let vadInterval = null;
let isSpeaking = false;
let vadThreshold = 25;
let currentVadLevel = 0;

// Screen share state
let screenStream = null;
let screenSender = null;
let isScreenSharing = false;
let screenPreviewInterval = null;
let latestScreenPreview = null;
let screenShareUsername = null;

// ─── WebSocket ────────────────────────────────────────────────

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        reconnectAttempts = 0;
        setConnectionStatus('connected');
    };

    ws.onclose = () => {
        setConnectionStatus('reconnecting');
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        setTimeout(connectWS, delay);
    };

    ws.onerror = () => {
        ws.close();
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
    };
}

function handleWSMessage(msg) {
    switch (msg.type) {
        case 'channel_users':
            updateChannelUsers(msg.channel_id, msg.users || []);
            break;
        case 'presence':
            updatePresence(msg.channels || {});
            break;
        case 'webrtc_answer':
            handleWebRTCAnswer(msg.payload);
            break;
        case 'webrtc_offer':
            handleWebRTCOffer(msg.payload);
            break;
        case 'ice_candidate':
            handleRemoteICECandidate(msg.payload);
            break;
        case 'screen_preview':
            latestScreenPreview = msg.payload.image;
            screenShareUsername = msg.username || null;
            // If there's already a play overlay visible, update its background
            if (document.getElementById('screen-share-play-overlay')) {
                updateScreenPreviewOverlay();
            } else if (!document.getElementById('screen-share-video') || document.getElementById('screen-share-video').classList.contains('hidden')) {
                // No video playing yet — show a preview container so user sees something is shared
                showScreenPreviewPlaceholder();
            }
            break;
        case 'screen_preview_clear':
            latestScreenPreview = null;
            screenShareUsername = null;
            removeRemoteVideo();
            break;
    }
}

function setConnectionStatus(state) {
    const el = document.getElementById('connection-status');
    const rtcEl = document.getElementById('rtc-status');
    if (state === 'connected') {
        el.textContent = 'Connected';
        el.className = 'text-xs text-vc-green';
    } else if (state === 'reconnecting') {
        el.textContent = 'Reconnecting...';
        el.className = 'text-xs text-vc-yellow';
    }
    if (rtcEl) updateRTCStatus();
}

function sendWS(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// ─── Channel Users UI ─────────────────────────────────────────

function updateChannelUsers(channelID, users) {
    const container = document.getElementById(`ch-users-${channelID}`);
    const countEl = document.getElementById(`ch-count-${channelID}`);
    if (!container) return;

    // Sort for stable order
    users.sort((a, b) => a.Username.localeCompare(b.Username));

    if (countEl) {
        countEl.textContent = users.length > 0 ? `${users.length} connected` : '';
    }

    const currentUsernames = new Set(users.map(u => u.Username));
    const existingItems = container.querySelectorAll('[data-sidebar-user]');
    const existingMap = {};
    existingItems.forEach(el => { existingMap[el.dataset.sidebarUser] = el; });

    // Remove users no longer present
    existingItems.forEach(el => {
        if (!currentUsernames.has(el.dataset.sidebarUser)) el.remove();
    });

    // Add or update each user
    users.forEach(u => {
        const existing = existingMap[u.Username];
        if (existing) {
            // Update in place
            const avatar = existing.querySelector('.sb-avatar');
            if (avatar) avatar.className = `sb-avatar w-6 h-6 rounded-full ${u.Speaking ? 'bg-vc-accent speaking-ring' : 'bg-vc-channel'} flex items-center justify-center text-xs font-bold text-white`;
            const name = existing.querySelector('.sb-name');
            if (name) name.className = `sb-name ${u.Muted ? 'text-vc-muted line-through' : 'text-vc-text'}`;
            const muteIcon = existing.querySelector('.sb-mute');
            if (muteIcon) muteIcon.style.display = u.Muted ? '' : 'none';
            const speakingEl = existing.querySelector('.sb-speaking');
            if (speakingEl) speakingEl.style.display = u.Speaking ? '' : 'none';
        } else {
            const div = document.createElement('div');
            div.dataset.sidebarUser = u.Username;
            div.className = 'flex items-center gap-2 px-2 py-1 rounded text-sm fade-in';
            div.innerHTML = `
                <div class="relative">
                    <div class="sb-avatar w-6 h-6 rounded-full ${u.Speaking ? 'bg-vc-accent speaking-ring' : 'bg-vc-channel'} flex items-center justify-center text-xs font-bold text-white">
                        ${u.Username.charAt(0).toUpperCase()}
                    </div>
                </div>
                <span class="sb-name ${u.Muted ? 'text-vc-muted line-through' : 'text-vc-text'}">${u.Username}</span>
                <svg class="sb-mute w-3 h-3 text-vc-red ml-auto" fill="currentColor" viewBox="0 0 24 24" style="display:${u.Muted ? '' : 'none'}"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
                <div class="sb-speaking ml-auto flex gap-0.5" style="display:${u.Speaking ? '' : 'none'}"><div class="w-1 h-3 bg-vc-accent rounded-full animate-pulse"></div><div class="w-1 h-4 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.1s"></div><div class="w-1 h-2 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.2s"></div></div>
            `;
            container.appendChild(div);
        }
    });

    if (channelID === currentChannelID) {
        updateMainContent(channelID, users);
    }
}

function updatePresence(channels) {
    for (const [chID, users] of Object.entries(channels)) {
        updateChannelUsers(parseInt(chID), users || []);
    }
}

// ─── Channel Join/Leave ───────────────────────────────────────

function joinChannel(channelID, channelName) {
    if (currentChannelID === channelID) return;

    document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.remove('bg-vc-hover/50');
    });
    const item = document.querySelector(`[data-channel-id="${channelID}"]`);
    if (item) item.classList.add('bg-vc-hover/50');

    // Cleanup previous WebRTC
    cleanupWebRTC();

    currentChannelID = channelID;
    sendWS({ type: 'join_channel', payload: { channel_id: channelID } });

    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        <div class="w-full h-full flex flex-col">
            <div class="px-6 py-4 border-b border-vc-border flex items-center gap-3">
                <svg class="w-6 h-6 text-vc-accent" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
                </svg>
                <h2 class="text-xl font-bold">${channelName}</h2>
                <div id="rtc-status" class="flex items-center gap-1.5 ml-4">
                    <div class="w-2 h-2 rounded-full bg-vc-yellow animate-pulse"></div>
                    <span class="text-xs text-vc-yellow">Connecting...</span>
                </div>
                <button onclick="leaveChannel()" class="ml-auto px-4 py-1.5 bg-vc-red/20 hover:bg-vc-red/30 text-vc-red text-sm font-medium rounded-lg transition">
                    Leave Channel
                </button>
            </div>
            <div class="flex-1 flex flex-col overflow-y-auto p-8">
                <div id="screen-share-anchor"></div>
                <div class="flex-1 flex items-center justify-center" id="channel-view-users">
                    <div class="text-center text-vc-muted">
                        <p>Joining channel...</p>
                    </div>
                </div>
            </div>
            <div class="px-6 py-3 border-t border-vc-border bg-vc-sidebar/50 flex items-center justify-center gap-4">
                <button onclick="toggleMute()" id="main-mute-btn"
                    class="flex items-center gap-2 px-4 py-2 rounded-lg ${isMuted ? 'bg-vc-red/20 text-vc-red' : 'bg-vc-channel hover:bg-vc-hover text-vc-text'} transition">
                    <svg class="w-5 h-5" id="main-icon-mic" fill="currentColor" viewBox="0 0 24 24">
                        ${isMuted ?
                            '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>' :
                            '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>'}
                    </svg>
                    <span id="main-mute-text">${isMuted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button onclick="isScreenSharing ? stopScreenShare() : startScreenShare()" id="screen-share-btn"
                    class="flex items-center gap-2 px-4 py-2 rounded-lg bg-vc-channel hover:bg-vc-hover text-vc-text transition">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                    </svg>
                    <span>Share Screen</span>
                </button>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-vc-muted">Sensitivity</span>
                    <div class="flex items-center gap-2 w-36">
                        <input type="range" min="1" max="60" value="${vadThreshold}" oninput="setVadThreshold(this.value)"
                            class="w-full h-1.5 rounded-full appearance-none bg-vc-border cursor-pointer accent-vc-accent">
                    </div>
                    <div class="w-16 h-2 bg-vc-bg rounded-full overflow-hidden border border-vc-border">
                        <div id="vad-meter" class="h-full rounded-full bg-vc-muted/50 transition-all duration-75" style="width:0%"></div>
                    </div>
                </div>
                <button onclick="togglePTT()" id="ptt-btn"
                    class="flex items-center gap-2 px-4 py-2 rounded-lg ${pushToTalk ? 'bg-vc-accent/20 text-vc-accent' : 'bg-vc-channel hover:bg-vc-hover text-vc-muted'} transition text-sm">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
                    </svg>
                    PTT ${pushToTalk ? 'ON' : 'OFF'}
                </button>
                <div class="text-xs text-vc-muted" id="ptt-hint">${pushToTalk ? 'Hold Space to talk' : ''}</div>
            </div>
        </div>
    `;

    // Start WebRTC
    startWebRTC();
}

function updateMainContent(channelID, users) {
    const container = document.getElementById('channel-view-users');
    if (!container) return;

    // Sort users consistently by username to prevent reordering
    users.sort((a, b) => a.Username.localeCompare(b.Username));

    if (users.length === 0) {
        container.innerHTML = `
            <div class="text-center text-vc-muted">
                <p class="text-lg font-medium">Nobody here yet</p>
                <p class="text-sm mt-1">Invite your friends to join!</p>
            </div>
        `;
        return;
    }

    // Check if grid already exists — if so, update in place
    let grid = container.querySelector('.user-grid');
    if (!grid) {
        grid = document.createElement('div');
        grid.className = 'user-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6';
        container.innerHTML = '';
        container.appendChild(grid);
    }

    const existingCards = grid.querySelectorAll('[data-username]');
    const existingMap = {};
    existingCards.forEach(card => { existingMap[card.dataset.username] = card; });

    const currentUsernames = new Set(users.map(u => u.Username));

    // Remove users no longer present
    existingCards.forEach(card => {
        if (!currentUsernames.has(card.dataset.username)) {
            card.remove();
        }
    });

    // Add or update each user
    users.forEach(u => {
        const existing = existingMap[u.Username];
        if (existing) {
            // Update in place — only change classes/content that differ
            const border = u.Speaking ? 'border-vc-green shadow-lg shadow-vc-green/20' : 'border-vc-border';
            existing.className = `flex flex-col items-center gap-3 p-4 rounded-xl bg-vc-sidebar/50 border ${border} transition-all duration-200`;

            const avatar = existing.querySelector('.avatar-circle');
            if (avatar) {
                avatar.className = `avatar-circle w-16 h-16 rounded-full ${u.Speaking ? 'bg-vc-accent speaking-ring' : 'bg-vc-channel'} flex items-center justify-center text-2xl font-bold text-white transition-all`;
            }

            const muteIndicator = existing.querySelector('.mute-indicator');
            if (muteIndicator) muteIndicator.style.display = u.Muted ? '' : 'none';

            const nameEl = existing.querySelector('.user-name');
            if (nameEl) nameEl.className = `user-name text-sm font-medium ${u.Muted ? 'text-vc-muted' : 'text-vc-text'}`;

            const speakingIndicator = existing.querySelector('.speaking-indicator');
            if (speakingIndicator) speakingIndicator.style.display = u.Speaking ? '' : 'none';
            const spacer = existing.querySelector('.speaking-spacer');
            if (spacer) spacer.style.display = u.Speaking ? 'none' : '';
        } else {
            // New user — create card with fade-in
            const card = document.createElement('div');
            card.dataset.username = u.Username;
            card.className = `flex flex-col items-center gap-3 p-4 rounded-xl bg-vc-sidebar/50 border ${u.Speaking ? 'border-vc-green shadow-lg shadow-vc-green/20' : 'border-vc-border'} fade-in transition-all duration-200`;
            card.innerHTML = `
                <div class="relative">
                    <div class="avatar-circle w-16 h-16 rounded-full ${u.Speaking ? 'bg-vc-accent speaking-ring' : 'bg-vc-channel'} flex items-center justify-center text-2xl font-bold text-white transition-all">
                        ${u.Username.charAt(0).toUpperCase()}
                    </div>
                    <div class="mute-indicator absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-vc-red flex items-center justify-center" style="display:${u.Muted ? '' : 'none'}"><svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg></div>
                </div>
                <span class="user-name text-sm font-medium ${u.Muted ? 'text-vc-muted' : 'text-vc-text'}">${u.Username}</span>
                <div class="speaking-indicator flex gap-1" style="display:${u.Speaking ? '' : 'none'}"><div class="w-1.5 h-3 bg-vc-accent rounded-full animate-pulse"></div><div class="w-1.5 h-5 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.15s"></div><div class="w-1.5 h-3 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.3s"></div></div>
                <div class="speaking-spacer h-5" style="display:${u.Speaking ? 'none' : ''}"></div>
            `;
            grid.appendChild(card);
        }
    });
}

function leaveChannel() {
    if (!currentChannelID) return;
    sendWS({ type: 'leave_channel' });
    currentChannelID = null;
    cleanupWebRTC();

    document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.remove('bg-vc-hover/50');
    });

    document.getElementById('main-content').innerHTML = `
        <div class="text-center text-vc-muted">
            <svg class="w-20 h-20 mx-auto mb-4 opacity-20" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            <p class="text-lg font-medium">Select a voice channel</p>
            <p class="text-sm mt-1">Click a channel to join and start talking</p>
        </div>
    `;
}

// ─── Mute / PTT ───────────────────────────────────────────────

function toggleMute() {
    // Can't unmute without mic access
    if (!localStream && isMuted) return;

    isMuted = !isMuted;
    sendWS({ type: 'mute', payload: { muted: isMuted } });

    // Mute/unmute the actual audio track
    if (localStream) {
        localStream.getAudioTracks().forEach(t => {
            t.enabled = !isMuted;
        });
    }

    updateMuteUI();
}

function togglePTT() {
    pushToTalk = !pushToTalk;
    const btn = document.getElementById('ptt-btn');
    const hint = document.getElementById('ptt-hint');
    if (btn) {
        btn.className = `flex items-center gap-2 px-4 py-2 rounded-lg ${pushToTalk ? 'bg-vc-accent/20 text-vc-accent' : 'bg-vc-channel hover:bg-vc-hover text-vc-muted'} transition text-sm`;
        btn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            PTT ${pushToTalk ? 'ON' : 'OFF'}`;
    }
    if (hint) hint.textContent = pushToTalk ? 'Hold Space to talk' : '';

    if (pushToTalk) {
        // In PTT mode, mute by default
        if (localStream) {
            localStream.getAudioTracks().forEach(t => { t.enabled = false; });
        }
    } else {
        // Open mic mode - respect mute state
        if (localStream) {
            localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
        }
    }
}

// ─── WebRTC ───────────────────────────────────────────────────

async function startWebRTC() {
    try {
        // Get microphone access
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false,
        });

        // Apply mute state
        localStream.getAudioTracks().forEach(t => {
            t.enabled = pushToTalk ? false : !isMuted;
        });

        // Setup VAD
        setupVAD(localStream);

        // Create peer connection
        peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ],
        });

        // Add audio track
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        // Handle remote tracks (audio from other peers)
        peerConnection.ontrack = (event) => {
            if (event.track.kind === 'audio') {
                const audio = new Audio();
                audio.srcObject = event.streams[0];
                audio.autoplay = true;
                audio.play().catch(() => {});
            } else if (event.track.kind === 'video') {
                const stream = event.streams[0] || new MediaStream([event.track]);
                showRemoteVideo(stream, event.track);
            }
        };

        // ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendWS({
                    type: 'ice_candidate',
                    payload: { candidate: event.candidate.toJSON() },
                });
            }
        };

        // Connection state
        peerConnection.onconnectionstatechange = () => {
            updateRTCStatus();
        };

        peerConnection.oniceconnectionstatechange = () => {
            updateRTCStatus();
        };

        // Create and send offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        sendWS({
            type: 'webrtc_offer',
            payload: { sdp: offer.sdp },
        });

    } catch (err) {
        console.error('WebRTC setup failed:', err);
        updateRTCStatusText('error', 'Mic access denied');
        showGlobalMicWarning();
        // Force muted state when mic is unavailable
        if (!isMuted) {
            isMuted = true;
            sendWS({ type: 'mute', payload: { muted: true } });
            updateMuteUI();
        }
    }
}

function updateMuteUI() {
    // Update sidebar icons
    document.getElementById('icon-mic').classList.toggle('hidden', isMuted);
    document.getElementById('icon-mic-off').classList.toggle('hidden', !isMuted);

    // Update main content button
    const mainBtn = document.getElementById('main-mute-btn');
    const mainText = document.getElementById('main-mute-text');
    const mainIcon = document.getElementById('main-icon-mic');
    if (mainBtn) {
        mainBtn.className = `flex items-center gap-2 px-4 py-2 rounded-lg ${isMuted ? 'bg-vc-red/20 text-vc-red' : 'bg-vc-channel hover:bg-vc-hover text-vc-text'} transition`;
    }
    if (mainText) mainText.textContent = isMuted ? 'Unmute' : 'Mute';
    if (mainIcon) {
        mainIcon.innerHTML = isMuted ?
            '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>' :
            '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>';
    }
}

function handleWebRTCAnswer(payload) {
    if (!peerConnection) return;
    peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: payload.sdp })
    ).catch(err => console.error('Failed to set remote description:', err));
}

async function handleWebRTCOffer(payload) {
    // Server-initiated renegotiation (new peer joined with audio)
    if (!peerConnection) return;

    await peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp: payload.sdp })
    );

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendWS({
        type: 'webrtc_answer',
        payload: { sdp: answer.sdp },
    });

    // Check if remote video tracks are still present; if not, remove video container
    const receivers = peerConnection.getReceivers();
    const hasVideo = receivers.some(r => r.track && r.track.kind === 'video' && r.track.readyState === 'live');
    if (!hasVideo) {
        removeRemoteVideo();
    }
}

function handleRemoteICECandidate(payload) {
    if (!peerConnection) return;
    peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate))
        .catch(err => console.error('Failed to add ICE candidate:', err));
}

async function startScreenShare() {
    if (!peerConnection || isScreenSharing) return;

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false,
        });

        const videoTrack = screenStream.getVideoTracks()[0];
        screenSender = peerConnection.addTrack(videoTrack, screenStream);
        isScreenSharing = true;

        // When user stops sharing via browser UI
        videoTrack.onended = () => {
            stopScreenShare();
        };

        // Show local preview
        showLocalScreenPreview(screenStream);

        // Renegotiate
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendWS({
            type: 'webrtc_offer',
            payload: { sdp: offer.sdp },
        });

        updateScreenShareUI();

        // Start sending screen preview thumbnails
        setTimeout(captureAndSendPreview, 500);
        screenPreviewInterval = setInterval(captureAndSendPreview, 5 * 60 * 1000);
    } catch (err) {
        console.error('Screen share failed:', err);
    }
}

async function stopScreenShare() {
    if (!isScreenSharing) return;

    clearInterval(screenPreviewInterval);
    screenPreviewInterval = null;

    if (screenSender && peerConnection) {
        peerConnection.removeTrack(screenSender);
    }
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenSender = null;
    isScreenSharing = false;

    // Renegotiate to remove video track
    if (peerConnection) {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sendWS({
                type: 'webrtc_offer',
                payload: { sdp: offer.sdp },
            });
        } catch (err) {
            console.error('Failed to renegotiate after stopping screen share:', err);
        }
    }

    removeLocalScreenPreview();
    updateScreenShareUI();
}

function showLocalScreenPreview(stream) {
    removeLocalScreenPreview();

    const container = document.getElementById('channel-view-users');
    if (!container) return;

    const previewContainer = document.createElement('div');
    previewContainer.id = 'local-screen-preview';
    previewContainer.className = 'w-full bg-black rounded-xl overflow-hidden mb-4 relative';
    previewContainer.style.maxHeight = '70vh';

    const label = document.createElement('div');
    label.className = 'absolute top-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded';
    label.textContent = 'Your screen';

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.className = 'w-full h-full object-contain';
    video.style.maxHeight = '70vh';

    previewContainer.appendChild(video);
    previewContainer.appendChild(label);
    container.parentElement.insertBefore(previewContainer, container);
    video.play().catch(() => {});
}

function removeLocalScreenPreview() {
    const el = document.getElementById('local-screen-preview');
    if (el) el.remove();
}

function showRemoteVideo(stream, track) {
    // Remove any existing video container first
    removeRemoteVideo();

    const container = document.getElementById('channel-view-users');
    if (!container) return;

    const videoContainer = document.createElement('div');
    videoContainer.id = 'screen-share-container';
    videoContainer.className = 'w-full bg-vc-sidebar rounded-xl overflow-hidden mb-4 relative';
    videoContainer.style.maxHeight = '70vh';

    const video = document.createElement('video');
    video.id = 'screen-share-video';
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.className = 'w-full h-full object-contain hidden';
    video.style.maxHeight = '70vh';

    // Play button overlay
    const playOverlay = document.createElement('div');
    playOverlay.id = 'screen-share-play-overlay';
    if (latestScreenPreview) {
        playOverlay.className = 'relative overflow-hidden cursor-pointer';
        playOverlay.style.minHeight = '300px';
        playOverlay.innerHTML = `
            <div class="preview-bg absolute inset-0" style="background-image:url(${latestScreenPreview});background-size:cover;background-position:center;filter:blur(8px);transform:scale(1.1)"></div>
            <div class="relative flex flex-col items-center justify-center gap-3 py-12 z-10">
                <div class="w-16 h-16 rounded-full bg-vc-accent flex items-center justify-center hover:bg-vc-accent/80 transition">
                    <svg class="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </div>
                <span class="text-vc-text text-sm font-medium">${screenShareUsername ? screenShareUsername + ' is sharing their screen' : 'Someone is sharing their screen'}</span>
                <span class="text-vc-muted text-xs">Click to watch</span>
            </div>
        `;
    } else {
        playOverlay.className = 'flex flex-col items-center justify-center gap-3 py-12 cursor-pointer';
        playOverlay.innerHTML = `
            <div class="w-16 h-16 rounded-full bg-vc-accent flex items-center justify-center hover:bg-vc-accent/80 transition">
                <svg class="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z"/>
                </svg>
            </div>
            <span class="text-vc-text text-sm font-medium">${screenShareUsername ? screenShareUsername + ' is sharing their screen' : 'Someone is sharing their screen'}</span>
            <span class="text-vc-muted text-xs">Click to watch</span>
        `;
    }
    playOverlay.onclick = () => {
        video.classList.remove('hidden');
        playOverlay.remove();
        videoContainer.className = 'w-full bg-black rounded-xl overflow-hidden mb-4 relative';
        video.play().catch(() => {});
    };

    videoContainer.appendChild(video);
    videoContainer.appendChild(playOverlay);
    container.parentElement.insertBefore(videoContainer, container);

    // Clean up when track ends or is muted (SFU removed it)
    track.onended = () => removeRemoteVideo();
    track.onmute = () => removeRemoteVideo();
}

function removeRemoteVideo() {
    const container = document.getElementById('screen-share-container');
    if (container) container.remove();
}

function updateScreenShareUI() {
    const btn = document.getElementById('screen-share-btn');
    if (!btn) return;
    if (isScreenSharing) {
        btn.className = 'flex items-center gap-2 px-4 py-2 rounded-lg bg-vc-green/20 text-vc-green transition';
        btn.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <span>Stop Sharing</span>`;
    } else {
        btn.className = 'flex items-center gap-2 px-4 py-2 rounded-lg bg-vc-channel hover:bg-vc-hover text-vc-text transition';
        btn.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <span>Share Screen</span>`;
    }
}

function showScreenPreviewPlaceholder() {
    if (!latestScreenPreview) return;
    if (document.getElementById('screen-share-container')) return;

    const container = document.getElementById('channel-view-users');
    if (!container) return;

    const videoContainer = document.createElement('div');
    videoContainer.id = 'screen-share-container';
    videoContainer.className = 'w-full bg-vc-sidebar rounded-xl overflow-hidden mb-4 relative';
    videoContainer.style.maxHeight = '70vh';

    const playOverlay = document.createElement('div');
    playOverlay.id = 'screen-share-play-overlay';
    playOverlay.className = 'relative overflow-hidden cursor-pointer';
    playOverlay.style.minHeight = '300px';
    playOverlay.innerHTML = `
        <div class="preview-bg absolute inset-0" style="background-image:url(${latestScreenPreview});background-size:cover;background-position:center;filter:blur(8px);transform:scale(1.1)"></div>
        <div class="relative flex flex-col items-center justify-center gap-3 py-12 z-10">
            <div class="w-16 h-16 rounded-full bg-vc-accent flex items-center justify-center hover:bg-vc-accent/80 transition">
                <svg class="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z"/>
                </svg>
            </div>
            <span class="text-vc-text text-sm font-medium">${screenShareUsername ? screenShareUsername + ' is sharing their screen' : 'Someone is sharing their screen'}</span>
            <span class="text-vc-muted text-xs">Click to watch</span>
        </div>
    `;
    playOverlay.onclick = () => {
        // When clicked, the actual WebRTC video should be available
        // Request a renegotiation or just wait for the video track
        playOverlay.innerHTML = `
            <div class="flex flex-col items-center justify-center gap-3 py-12">
                <div class="w-8 h-8 border-2 border-vc-accent border-t-transparent rounded-full animate-spin"></div>
                <span class="text-vc-muted text-xs">Connecting to screen share...</span>
            </div>
        `;
    };

    videoContainer.appendChild(playOverlay);
    container.parentElement.insertBefore(videoContainer, container);
}

function captureAndSendPreview() {
    if (!screenStream) return;
    const video = document.querySelector('#local-screen-preview video');
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = Math.round(320 * video.videoHeight / video.videoWidth);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    sendWS({ type: 'screen_preview', payload: { image: dataUrl } });
}

function updateScreenPreviewOverlay() {
    const overlay = document.getElementById('screen-share-play-overlay');
    if (!overlay || !latestScreenPreview) return;
    // Ensure the overlay has the blurred background structure
    let bgDiv = overlay.querySelector('.preview-bg');
    if (!bgDiv) {
        // Restructure: wrap existing content, add blurred bg
        overlay.className = 'relative overflow-hidden cursor-pointer';
        overlay.style.minHeight = '300px';
        const existingContent = overlay.innerHTML;
        overlay.innerHTML = '';
        bgDiv = document.createElement('div');
        bgDiv.className = 'preview-bg absolute inset-0';
        bgDiv.style.cssText = 'background-size:cover;background-position:center;filter:blur(8px);transform:scale(1.1)';
        overlay.appendChild(bgDiv);
        const contentDiv = document.createElement('div');
        contentDiv.className = 'relative flex flex-col items-center justify-center gap-3 py-12 z-10';
        contentDiv.innerHTML = existingContent;
        overlay.appendChild(contentDiv);
    }
    bgDiv.style.backgroundImage = `url(${latestScreenPreview})`;
}

function cleanupWebRTC() {
    clearInterval(screenPreviewInterval);
    screenPreviewInterval = null;
    latestScreenPreview = null;
    screenShareUsername = null;
    if (vadInterval) {
        clearInterval(vadInterval);
        vadInterval = null;
    }
    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
        analyser = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenSender = null;
    isScreenSharing = false;
    removeRemoteVideo();
    removeLocalScreenPreview();
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    isSpeaking = false;
}

function updateRTCStatus() {
    if (!peerConnection) return;
    const state = peerConnection.connectionState || peerConnection.iceConnectionState;
    switch (state) {
        case 'connected':
        case 'completed':
            updateRTCStatusText('connected', 'Voice connected');
            break;
        case 'connecting':
        case 'checking':
        case 'new':
            updateRTCStatusText('connecting', 'Connecting...');
            break;
        case 'disconnected':
            updateRTCStatusText('warning', 'Disconnected');
            break;
        case 'failed':
            updateRTCStatusText('error', 'Connection failed');
            break;
        case 'closed':
            updateRTCStatusText('error', 'Closed');
            break;
    }
}

function updateRTCStatusText(state, text) {
    const el = document.getElementById('rtc-status');
    if (!el) return;

    const colors = {
        connected: { dot: 'bg-vc-green', text: 'text-vc-green', pulse: '' },
        connecting: { dot: 'bg-vc-yellow', text: 'text-vc-yellow', pulse: 'animate-pulse' },
        warning: { dot: 'bg-vc-yellow', text: 'text-vc-yellow', pulse: '' },
        error: { dot: 'bg-vc-red', text: 'text-vc-red', pulse: '' },
    };
    const c = colors[state] || colors.error;
    el.innerHTML = `
        <div class="w-2 h-2 rounded-full ${c.dot} ${c.pulse}"></div>
        <span class="text-xs ${c.text}">${text}</span>
    `;
}

// ─── Voice Activity Detection ─────────────────────────────────

function setupVAD(stream) {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let silenceCount = 0;
    const SILENCE_DELAY = 5; // ~250ms at 50ms intervals

    vadInterval = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        currentVadLevel = sum / dataArray.length;

        // Update level meter
        const meter = document.getElementById('vad-meter');
        if (meter) {
            const pct = Math.min(100, (currentVadLevel / 80) * 100);
            meter.style.width = pct + '%';
            meter.className = `h-full rounded-full transition-all duration-75 ${currentVadLevel > vadThreshold ? 'bg-vc-green' : 'bg-vc-muted/50'}`;
        }

        if (isMuted || (pushToTalk && !pttActive)) return;

        const voiceDetected = currentVadLevel > vadThreshold;

        if (voiceDetected) {
            silenceCount = 0;
            // Enable audio track when voice detected
            if (localStream) {
                localStream.getAudioTracks().forEach(t => { t.enabled = true; });
            }
            if (!isSpeaking) {
                isSpeaking = true;
                sendWS({ type: 'speaking', payload: { speaking: true } });
            }
        } else {
            silenceCount++;
            if (silenceCount >= SILENCE_DELAY) {
                // Disable audio track when silent
                if (localStream && !pushToTalk) {
                    localStream.getAudioTracks().forEach(t => { t.enabled = false; });
                }
                if (isSpeaking) {
                    isSpeaking = false;
                    sendWS({ type: 'speaking', payload: { speaking: false } });
                }
            }
        }
    }, 50);
}

function setVadThreshold(value) {
    vadThreshold = parseInt(value);
    const label = document.getElementById('vad-threshold-label');
    if (label) label.textContent = vadThreshold;
}

// ─── Push-to-Talk Keyboard ────────────────────────────────────

document.addEventListener('keydown', (e) => {
    if (!pushToTalk || !localStream) return;
    if (e.code === 'Space' && !e.repeat && !isInputFocused()) {
        e.preventDefault();
        pttActive = true;
        localStream.getAudioTracks().forEach(t => { t.enabled = true; });
    }
});

document.addEventListener('keyup', (e) => {
    if (!pushToTalk || !localStream) return;
    if (e.code === 'Space' && !isInputFocused()) {
        e.preventDefault();
        pttActive = false;
        localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    }
});

function isInputFocused() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.contentEditable === 'true');
}

// ─── Init ─────────────────────────────────────────────────────

connectWS();
checkMicPermission();

async function checkMicPermission() {
    try {
        const result = await navigator.permissions.query({ name: 'microphone' });
        if (result.state === 'denied') {
            showGlobalMicWarning();
        } else if (result.state === 'prompt') {
            // Proactively request mic access so the browser shows the permission prompt
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
            } catch (e) {
                showGlobalMicWarning();
            }
        }
        result.addEventListener('change', () => {
            if (result.state === 'denied') {
                showGlobalMicWarning();
            } else {
                hideGlobalMicWarning();
            }
        });
    } catch (e) {
        // permissions.query not supported, try getUserMedia directly
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
        } catch (err) {
            showGlobalMicWarning();
        }
    }
}

function showGlobalMicWarning() {
    if (!isMuted) {
        isMuted = true;
        updateMuteUI();
    }
    if (document.getElementById('global-mic-warning')) return;
    const banner = document.createElement('div');
    banner.id = 'global-mic-warning';
    banner.className = 'fixed top-0 left-0 right-0 z-50 bg-vc-red/90 backdrop-blur-sm text-white px-4 py-3 flex items-center justify-center gap-3 text-sm shadow-lg';
    banner.innerHTML = `
        <svg class="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
        </svg>
        <span><strong>Microphone blocked</strong> — Click the lock icon in the address bar, allow microphone access, and reload the page.</span>
    `;
    document.body.prepend(banner);
}

function hideGlobalMicWarning() {
    const banner = document.getElementById('global-mic-warning');
    if (banner) banner.remove();
}
