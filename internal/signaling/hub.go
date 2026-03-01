package signaling

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/kidandcat/vocipher/internal/auth"
	"github.com/kidandcat/vocipher/internal/channel"
	rtc "github.com/kidandcat/vocipher/internal/webrtc"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type Client struct {
	UserID   int64
	Username string
	Conn     *websocket.Conn
	Send     chan []byte
}

type Hub struct {
	mu      sync.RWMutex
	clients map[int64]*Client
}

var GlobalHub = &Hub{
	clients: make(map[int64]*Client),
}

// Screen share preview store: channelID -> latest screen_preview JSON message
var (
	previewMu       sync.RWMutex
	channelPreviews = map[int64][]byte{}
)

func (h *Hub) Register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[client.UserID] = client
}

func (h *Hub) Unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.clients[client.UserID]; ok {
		close(client.Send)
		delete(h.clients, client.UserID)
	}
}

func (h *Hub) Broadcast(msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		select {
		case client.Send <- msg:
		default:
			// drop message if client is too slow
		}
	}
}

func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	users := channel.GetUsers(channelID)
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, u := range users {
		if client, ok := h.clients[u.ID]; ok {
			select {
			case client.Send <- msg:
			default:
			}
		}
	}
}

func (h *Hub) SendTo(userID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if client, ok := h.clients[userID]; ok {
		select {
		case client.Send <- msg:
		default:
		}
	}
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromRequest(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("websocket upgrade error:", err)
		return
	}

	client := &Client{
		UserID:   user.ID,
		Username: user.Username,
		Conn:     conn,
		Send:     make(chan []byte, 256),
	}

	GlobalHub.Register(client)

	go client.writePump()
	go client.readPump()
}

func (c *Client) writePump() {
	defer c.Conn.Close()
	for msg := range c.Send {
		if err := c.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		chID := channel.Leave(c.UserID)
		GlobalHub.Unregister(c)
		c.Conn.Close()
		if chID > 0 {
			cleanupWebRTC(chID, c.UserID)
			clearPreviewIfSharer(chID, c.UserID)
			broadcastChannelUpdate(chID)
		}
		broadcastPresence()
	}()

	for {
		_, raw, err := c.Conn.ReadMessage()
		if err != nil {
			return
		}

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		handleMessage(c, msg)
	}
}

func handleMessage(c *Client, msg Message) {
	switch msg.Type {
	case "join_channel":
		var p struct {
			ChannelID int64 `json:"channel_id"`
		}
		json.Unmarshal(msg.Payload, &p)

		oldCh := channel.GetUserChannel(c.UserID)
		if oldCh > 0 {
			cleanupWebRTC(oldCh, c.UserID)
			clearPreviewIfSharer(oldCh, c.UserID)
		}
		channel.Join(p.ChannelID, c.UserID, c.Username)

		if oldCh > 0 {
			broadcastChannelUpdate(oldCh)
		}
		broadcastChannelUpdate(p.ChannelID)
		broadcastPresence()

		// Send current screen preview to the joining user if one exists
		previewMu.RLock()
		if preview, ok := channelPreviews[p.ChannelID]; ok {
			GlobalHub.SendTo(c.UserID, preview)
		}
		previewMu.RUnlock()

	case "leave_channel":
		chID := channel.Leave(c.UserID)
		if chID > 0 {
			cleanupWebRTC(chID, c.UserID)
			clearPreviewIfSharer(chID, c.UserID)
			broadcastChannelUpdate(chID)
		}
		broadcastPresence()

	case "mute":
		var p struct {
			Muted bool `json:"muted"`
		}
		json.Unmarshal(msg.Payload, &p)
		channel.SetMuted(c.UserID, p.Muted)
		chID := channel.GetUserChannel(c.UserID)
		if chID > 0 {
			broadcastChannelUpdate(chID)
		}

	case "speaking":
		var p struct {
			Speaking bool `json:"speaking"`
		}
		json.Unmarshal(msg.Payload, &p)
		channel.SetSpeaking(c.UserID, p.Speaking)
		chID := channel.GetUserChannel(c.UserID)
		if chID > 0 {
			broadcastChannelUpdate(chID)
		}

	case "webrtc_offer":
		var p struct {
			SDP string `json:"sdp"`
		}
		if err := json.Unmarshal(msg.Payload, &p); err != nil {
			log.Printf("signaling: bad webrtc_offer from user %d: %v", c.UserID, err)
			return
		}
		chID := channel.GetUserChannel(c.UserID)
		if chID == 0 {
			return
		}
		sfu := rtc.GetOrCreateSFU(chID, func(userID int64, data []byte) {
			GlobalHub.SendTo(userID, data)
		})
		if err := sfu.HandleOffer(c.UserID, c.Username, p.SDP); err != nil {
			log.Printf("signaling: webrtc offer failed for user %d: %v", c.UserID, err)
		}
		// Clear preview if the renegotiation removed the video track
		if !sdpHasVideoSending(p.SDP) {
			clearPreviewIfSharer(chID, c.UserID)
		}

	case "webrtc_answer":
		var p struct {
			SDP string `json:"sdp"`
		}
		if err := json.Unmarshal(msg.Payload, &p); err != nil {
			return
		}
		chID := channel.GetUserChannel(c.UserID)
		if chID == 0 {
			return
		}
		sfu := rtc.GetOrCreateSFU(chID, func(userID int64, data []byte) {
			GlobalHub.SendTo(userID, data)
		})
		if err := sfu.HandleAnswer(c.UserID, p.SDP); err != nil {
			log.Printf("signaling: webrtc answer failed for user %d: %v", c.UserID, err)
		}

	case "screen_preview":
		var p struct {
			Image string `json:"image"`
		}
		if err := json.Unmarshal(msg.Payload, &p); err != nil || p.Image == "" {
			return
		}
		chID := channel.GetUserChannel(c.UserID)
		if chID == 0 {
			return
		}
		broadcastMsg, _ := json.Marshal(map[string]any{
			"type":     "screen_preview",
			"user_id":  c.UserID,
			"username": c.Username,
			"payload":  map[string]string{"image": p.Image},
		})
		previewMu.Lock()
		channelPreviews[chID] = broadcastMsg
		previewMu.Unlock()
		// Broadcast to all channel members except the sender
		users := channel.GetUsers(chID)
		GlobalHub.mu.RLock()
		for _, u := range users {
			if u.ID == c.UserID {
				continue
			}
			if client, ok := GlobalHub.clients[u.ID]; ok {
				select {
				case client.Send <- broadcastMsg:
				default:
				}
			}
		}
		GlobalHub.mu.RUnlock()

	case "ice_candidate":
		var p struct {
			Candidate json.RawMessage `json:"candidate"`
		}
		if err := json.Unmarshal(msg.Payload, &p); err != nil {
			return
		}
		chID := channel.GetUserChannel(c.UserID)
		if chID == 0 {
			return
		}
		sfu := rtc.GetOrCreateSFU(chID, func(userID int64, data []byte) {
			GlobalHub.SendTo(userID, data)
		})
		if err := sfu.HandleICECandidate(c.UserID, p.Candidate); err != nil {
			log.Printf("signaling: ice candidate failed for user %d: %v", c.UserID, err)
		}
	}
}

func cleanupWebRTC(channelID int64, userID int64) {
	sfu := rtc.GetOrCreateSFU(channelID, func(uid int64, data []byte) {
		GlobalHub.SendTo(uid, data)
	})
	sfu.RemovePeer(userID)
	rtc.RemoveSFU(channelID)
}

func broadcastChannelUpdate(channelID int64) {
	users := channel.GetUsers(channelID)
	data, _ := json.Marshal(map[string]any{
		"type":       "channel_users",
		"channel_id": channelID,
		"users":      users,
	})
	GlobalHub.Broadcast(data)
}

func broadcastPresence() {
	states := channel.GetAllChannelStates()
	data, _ := json.Marshal(map[string]any{
		"type":     "presence",
		"channels": states,
	})
	GlobalHub.Broadcast(data)
}

// clearPreviewIfSharer clears the screen preview for a channel if the given user was the sharer.
func clearPreviewIfSharer(channelID int64, userID int64) {
	previewMu.Lock()
	stored, ok := channelPreviews[channelID]
	if !ok {
		previewMu.Unlock()
		return
	}
	// Check if the stored preview belongs to this user
	var preview struct {
		UserID int64 `json:"user_id"`
	}
	if err := json.Unmarshal(stored, &preview); err != nil || preview.UserID != userID {
		previewMu.Unlock()
		return
	}
	delete(channelPreviews, channelID)
	previewMu.Unlock()

	// Broadcast clear message to channel
	clearMsg, _ := json.Marshal(map[string]any{
		"type": "screen_preview_clear",
	})
	GlobalHub.BroadcastToChannel(channelID, clearMsg)
}

// sdpHasVideoSending checks if an SDP offer contains a video m-line that is sending.
func sdpHasVideoSending(sdp string) bool {
	// Look for m=video line that is not inactive/recvonly
	inVideo := false
	for _, line := range splitLines(sdp) {
		if len(line) > 7 && line[:8] == "m=video " {
			inVideo = true
			continue
		}
		if len(line) > 2 && line[:2] == "m=" {
			inVideo = false
			continue
		}
		if inVideo && len(line) > 2 && line[:2] == "a=" {
			if line == "a=sendrecv" || line == "a=sendonly" {
				return true
			}
			if line == "a=inactive" || line == "a=recvonly" {
				return false
			}
		}
	}
	return false
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			lines = append(lines, line)
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}
