package webrtc

import (
	"encoding/json"
	"log"
	"strings"
	"sync"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Peer represents a connected WebRTC peer in a channel.
type Peer struct {
	UserID   int64
	Username string
	PC       *webrtc.PeerConnection
	// Audio track this peer is sending
	audioTrack *webrtc.TrackRemote
	// Video track this peer is sending (screen share)
	videoTrack *webrtc.TrackRemote
	// Local tracks we forward to this peer (from other peers)
	outputTracks      map[int64]*webrtc.TrackLocalStaticRTP // srcUserID -> local audio track
	videoOutputTracks map[int64]*webrtc.TrackLocalStaticRTP // srcUserID -> local video track
	mu                sync.Mutex
}

// SFU manages all peer connections for a channel.
type SFU struct {
	mu    sync.RWMutex
	peers map[int64]*Peer // userID -> Peer

	// Callback to send signaling messages back to clients
	SendMessage func(userID int64, msg []byte)
}

var (
	globalMu sync.RWMutex
	sfus     = make(map[int64]*SFU) // channelID -> SFU
)

var api *webrtc.API

func init() {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		log.Fatal("webrtc: failed to register codecs:", err)
	}
	api = webrtc.NewAPI(webrtc.WithMediaEngine(m))
}

func newPeerConnectionConfig() webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		},
	}
}

// GetOrCreateSFU returns the SFU for a channel, creating one if needed.
func GetOrCreateSFU(channelID int64, sendMsg func(userID int64, msg []byte)) *SFU {
	globalMu.Lock()
	defer globalMu.Unlock()

	if s, ok := sfus[channelID]; ok {
		return s
	}

	s := &SFU{
		peers:       make(map[int64]*Peer),
		SendMessage: sendMsg,
	}
	sfus[channelID] = s
	return s
}

// RemoveSFU removes the SFU for a channel if it has no peers.
func RemoveSFU(channelID int64) {
	globalMu.Lock()
	defer globalMu.Unlock()

	if s, ok := sfus[channelID]; ok {
		s.mu.RLock()
		empty := len(s.peers) == 0
		s.mu.RUnlock()
		if empty {
			delete(sfus, channelID)
		}
	}
}

// HandleOffer processes an SDP offer from a client and returns an answer.
func (s *SFU) HandleOffer(userID int64, username string, offerSDP string) error {
	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerSDP,
	}

	// Check if this is a renegotiation for an existing peer
	s.mu.RLock()
	existingPeer, exists := s.peers[userID]
	s.mu.RUnlock()

	if exists {
		// Remember if peer had video before renegotiation
		hadVideo := existingPeer.videoTrack != nil

		// Renegotiation: reuse existing PeerConnection
		if err := existingPeer.PC.SetRemoteDescription(offer); err != nil {
			return err
		}

		answer, err := existingPeer.PC.CreateAnswer(nil)
		if err != nil {
			return err
		}

		if err := existingPeer.PC.SetLocalDescription(answer); err != nil {
			return err
		}

		data, _ := json.Marshal(map[string]any{
			"type": "webrtc_answer",
			"payload": map[string]any{
				"sdp": answer.SDP,
			},
		})
		s.SendMessage(userID, data)

		// Check if peer stopped sending video (screen share ended)
		if hadVideo && !sdpHasVideoSending(offerSDP) {
			go s.cleanupVideoTrack(existingPeer, userID)
		}

		return nil
	}

	// New peer: create new PeerConnection
	pc, err := api.NewPeerConnection(newPeerConnectionConfig())
	if err != nil {
		return err
	}

	peer := &Peer{
		UserID:            userID,
		Username:          username,
		PC:                pc,
		outputTracks:      make(map[int64]*webrtc.TrackLocalStaticRTP),
		videoOutputTracks: make(map[int64]*webrtc.TrackLocalStaticRTP),
	}

	// Handle incoming tracks from this peer
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		switch track.Kind() {
		case webrtc.RTPCodecTypeAudio:
			s.handleAudioTrack(peer, userID, username, track)
		case webrtc.RTPCodecTypeVideo:
			s.handleVideoTrack(peer, userID, username, track)
		}
	})

	// Handle ICE candidates from the server side
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		data, _ := json.Marshal(map[string]any{
			"type": "ice_candidate",
			"payload": map[string]any{
				"candidate": c.ToJSON(),
			},
		})
		s.SendMessage(userID, data)
	})

	// Use sync.Once to add existing tracks only after connection is established
	var addExistingOnce sync.Once

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("webrtc: peer %d (%s) connection state: %s", userID, username, state.String())

		if state == webrtc.PeerConnectionStateConnected {
			// Add existing tracks from other peers once ICE is established
			addExistingOnce.Do(func() {
				go s.addExistingTracksForPeer(peer, userID)
			})
		}

		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.RemovePeer(userID)
		}
	})

	// Set the remote offer
	if err := pc.SetRemoteDescription(offer); err != nil {
		pc.Close()
		return err
	}

	// Create answer
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return err
	}

	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return err
	}

	// Register peer
	s.mu.Lock()
	s.peers[userID] = peer
	s.mu.Unlock()

	// Send answer back
	data, _ := json.Marshal(map[string]any{
		"type": "webrtc_answer",
		"payload": map[string]any{
			"sdp": answer.SDP,
		},
	})
	s.SendMessage(userID, data)

	return nil
}

// sdpHasVideoSending checks if the SDP has an active video m-line sending data.
func sdpHasVideoSending(sdp string) bool {
	lines := strings.Split(sdp, "\n")
	inVideo := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "m=video") {
			inVideo = true
		} else if strings.HasPrefix(line, "m=") {
			inVideo = false
		}
		if inVideo && (line == "a=sendrecv" || line == "a=sendonly") {
			return true
		}
	}
	return false
}

// cleanupVideoTrack removes video output tracks from all peers when screen share ends.
func (s *SFU) cleanupVideoTrack(peer *Peer, userID int64) {
	log.Printf("webrtc: cleaning up video track for user %d (screen share ended via renegotiation)", userID)

	s.mu.Lock()
	peer.videoTrack = nil
	for otherID, otherPeer := range s.peers {
		if otherID == userID {
			continue
		}
		otherPeer.mu.Lock()
		delete(otherPeer.videoOutputTracks, userID)
		otherPeer.mu.Unlock()
	}
	s.mu.Unlock()

	// Renegotiate with all other peers to remove the video track
	s.mu.RLock()
	for otherID, otherPeer := range s.peers {
		if otherID == userID {
			continue
		}
		s.renegotiate(otherPeer)
	}
	s.mu.RUnlock()
}

// addExistingTracksForPeer adds audio/video tracks from other peers and renegotiates.
// Called in a goroutine after the connection is established.
func (s *SFU) addExistingTracksForPeer(peer *Peer, userID int64) {
	needsRenegotiation := false
	s.mu.RLock()
	for srcID, existingPeer := range s.peers {
		if srcID == userID {
			continue
		}
		if existingPeer.audioTrack != nil {
			if err := s.addTrackForPeer(peer, srcID, existingPeer.audioTrack); err != nil {
				log.Printf("webrtc: failed to add existing audio track from user %d to user %d: %v", srcID, userID, err)
			} else {
				needsRenegotiation = true
			}
		}
		if existingPeer.videoTrack != nil {
			if err := s.addVideoTrackForPeer(peer, srcID, existingPeer.videoTrack); err != nil {
				log.Printf("webrtc: failed to add existing video track from user %d to user %d: %v", srcID, userID, err)
			} else {
				needsRenegotiation = true
			}
		}
	}
	s.mu.RUnlock()

	if needsRenegotiation {
		s.renegotiate(peer)
	}
}

// HandleICECandidate adds a remote ICE candidate for a peer.
func (s *SFU) HandleICECandidate(userID int64, candidateJSON json.RawMessage) error {
	s.mu.RLock()
	peer, ok := s.peers[userID]
	s.mu.RUnlock()

	if !ok {
		return nil
	}

	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal(candidateJSON, &candidate); err != nil {
		return err
	}

	return peer.PC.AddICECandidate(candidate)
}

// RemovePeer closes and removes a peer from the SFU.
func (s *SFU) RemovePeer(userID int64) {
	s.mu.Lock()
	peer, ok := s.peers[userID]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(s.peers, userID)

	// Remove output tracks from other peers that were receiving this user's audio/video
	for _, otherPeer := range s.peers {
		otherPeer.mu.Lock()
		delete(otherPeer.outputTracks, userID)
		delete(otherPeer.videoOutputTracks, userID)
		otherPeer.mu.Unlock()
	}
	s.mu.Unlock()

	if peer.PC.ConnectionState() != webrtc.PeerConnectionStateClosed {
		peer.PC.Close()
	}

	log.Printf("webrtc: removed peer %d (%s)", userID, peer.Username)
}

func (s *SFU) handleAudioTrack(peer *Peer, userID int64, username string, track *webrtc.TrackRemote) {
	log.Printf("webrtc: received audio track from user %d (%s)", userID, username)

	s.mu.Lock()
	peer.audioTrack = track
	s.mu.Unlock()

	// Create output tracks for all other peers
	s.mu.RLock()
	for otherID, otherPeer := range s.peers {
		if otherID == userID {
			continue
		}
		if err := s.addTrackForPeer(otherPeer, userID, track); err != nil {
			log.Printf("webrtc: failed to add audio track from user %d to user %d: %v", userID, otherID, err)
		} else {
			s.renegotiate(otherPeer)
		}
	}
	s.mu.RUnlock()

	// Forward RTP packets
	buf := make([]byte, 1500)
	for {
		n, _, readErr := track.Read(buf)
		if readErr != nil {
			log.Printf("webrtc: audio track read ended for user %d: %v", userID, readErr)
			return
		}

		s.mu.RLock()
		for otherID, otherPeer := range s.peers {
			if otherID == userID {
				continue
			}
			otherPeer.mu.Lock()
			if lt, ok := otherPeer.outputTracks[userID]; ok {
				if _, writeErr := lt.Write(buf[:n]); writeErr != nil {
					log.Printf("webrtc: audio write to user %d failed: %v", otherID, writeErr)
				}
			}
			otherPeer.mu.Unlock()
		}
		s.mu.RUnlock()
	}
}

func (s *SFU) handleVideoTrack(peer *Peer, userID int64, username string, track *webrtc.TrackRemote) {
	log.Printf("webrtc: received video track from user %d (%s)", userID, username)

	s.mu.Lock()
	peer.videoTrack = track
	s.mu.Unlock()

	// Create video output tracks for all other peers
	s.mu.RLock()
	for otherID, otherPeer := range s.peers {
		if otherID == userID {
			continue
		}
		if err := s.addVideoTrackForPeer(otherPeer, userID, track); err != nil {
			log.Printf("webrtc: failed to add video track from user %d to user %d: %v", userID, otherID, err)
		} else {
			s.renegotiate(otherPeer)
		}
	}
	s.mu.RUnlock()

	// Send PLI to request a keyframe from the sender
	if err := peer.PC.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())},
	}); err != nil {
		log.Printf("webrtc: failed to send PLI for user %d: %v", userID, err)
	}

	// Forward RTP packets (larger buffer for video)
	buf := make([]byte, 4096)
	for {
		n, _, readErr := track.Read(buf)
		if readErr != nil {
			log.Printf("webrtc: video track read ended for user %d: %v", userID, readErr)
			break
		}

		s.mu.RLock()
		for otherID, otherPeer := range s.peers {
			if otherID == userID {
				continue
			}
			otherPeer.mu.Lock()
			if lt, ok := otherPeer.videoOutputTracks[userID]; ok {
				if _, writeErr := lt.Write(buf[:n]); writeErr != nil {
					log.Printf("webrtc: video write to user %d failed: %v", otherID, writeErr)
				}
			}
			otherPeer.mu.Unlock()
		}
		s.mu.RUnlock()
	}

	// Video track ended (user stopped sharing) — clean up
	log.Printf("webrtc: video track ended for user %d (%s), cleaning up", userID, username)
	s.mu.Lock()
	peer.videoTrack = nil
	for otherID, otherPeer := range s.peers {
		if otherID == userID {
			continue
		}
		otherPeer.mu.Lock()
		delete(otherPeer.videoOutputTracks, userID)
		otherPeer.mu.Unlock()
	}
	s.mu.Unlock()

	// Renegotiate with all other peers to remove the video track
	s.mu.RLock()
	for otherID, otherPeer := range s.peers {
		if otherID == userID {
			continue
		}
		s.renegotiate(otherPeer)
	}
	s.mu.RUnlock()
}

// addTrackForPeer creates a local track on destPeer that will receive RTP from srcTrack.
func (s *SFU) addTrackForPeer(destPeer *Peer, srcUserID int64, srcTrack *webrtc.TrackRemote) error {
	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		srcTrack.Codec().RTPCodecCapability,
		srcTrack.ID(),
		srcTrack.StreamID(),
	)
	if err != nil {
		return err
	}

	destPeer.mu.Lock()
	destPeer.outputTracks[srcUserID] = localTrack
	destPeer.mu.Unlock()

	if _, err := destPeer.PC.AddTrack(localTrack); err != nil {
		destPeer.mu.Lock()
		delete(destPeer.outputTracks, srcUserID)
		destPeer.mu.Unlock()
		return err
	}

	return nil
}

// addVideoTrackForPeer creates a local video track on destPeer that will receive RTP from srcTrack.
func (s *SFU) addVideoTrackForPeer(destPeer *Peer, srcUserID int64, srcTrack *webrtc.TrackRemote) error {
	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		srcTrack.Codec().RTPCodecCapability,
		srcTrack.ID(),
		srcTrack.StreamID(),
	)
	if err != nil {
		return err
	}

	destPeer.mu.Lock()
	destPeer.videoOutputTracks[srcUserID] = localTrack
	destPeer.mu.Unlock()

	if _, err := destPeer.PC.AddTrack(localTrack); err != nil {
		destPeer.mu.Lock()
		delete(destPeer.videoOutputTracks, srcUserID)
		destPeer.mu.Unlock()
		return err
	}

	return nil
}

// renegotiate sends a new offer to a peer after tracks change.
func (s *SFU) renegotiate(peer *Peer) {
	offer, err := peer.PC.CreateOffer(nil)
	if err != nil {
		log.Printf("webrtc: renegotiate offer failed for user %d: %v", peer.UserID, err)
		return
	}

	if err := peer.PC.SetLocalDescription(offer); err != nil {
		log.Printf("webrtc: renegotiate setlocal failed for user %d: %v", peer.UserID, err)
		return
	}

	data, _ := json.Marshal(map[string]any{
		"type": "webrtc_offer",
		"payload": map[string]any{
			"sdp": offer.SDP,
		},
	})
	s.SendMessage(peer.UserID, data)
}

// HandleAnswer processes an SDP answer from a client (during renegotiation).
func (s *SFU) HandleAnswer(userID int64, answerSDP string) error {
	s.mu.RLock()
	peer, ok := s.peers[userID]
	s.mu.RUnlock()

	if !ok {
		return nil
	}

	return peer.PC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  answerSDP,
	})
}
