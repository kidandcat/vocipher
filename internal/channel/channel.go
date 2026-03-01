package channel

import (
	"sync"

	"github.com/kidandcat/vocipher/internal/database"
)

type Channel struct {
	ID        int64
	Name      string
	CreatedBy int64
}

type ConnectedUser struct {
	ID       int64
	Username string
	Muted    bool
	Speaking bool
}

// In-memory state for who's in which channel
var (
	mu             sync.RWMutex
	channelUsers   = make(map[int64]map[int64]*ConnectedUser) // channelID -> userID -> user
	userToChannel  = make(map[int64]int64)                    // userID -> channelID
)

func Create(name string, createdBy int64) (*Channel, error) {
	res, err := database.DB.Exec("INSERT INTO channels (name, created_by) VALUES (?, ?)", name, createdBy)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Channel{ID: id, Name: name, CreatedBy: createdBy}, nil
}

func List() ([]Channel, error) {
	rows, err := database.DB.Query("SELECT id, name, created_by FROM channels ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []Channel
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.Name, &ch.CreatedBy); err != nil {
			return nil, err
		}
		channels = append(channels, ch)
	}
	return channels, nil
}

func Delete(id int64) error {
	_, err := database.DB.Exec("DELETE FROM channels WHERE id = ?", id)
	return err
}

func Join(channelID int64, userID int64, username string) {
	mu.Lock()
	defer mu.Unlock()

	// Leave current channel first
	if oldCh, ok := userToChannel[userID]; ok {
		if users, exists := channelUsers[oldCh]; exists {
			delete(users, userID)
		}
	}

	if channelUsers[channelID] == nil {
		channelUsers[channelID] = make(map[int64]*ConnectedUser)
	}
	channelUsers[channelID][userID] = &ConnectedUser{
		ID:       userID,
		Username: username,
	}
	userToChannel[userID] = channelID
}

func Leave(userID int64) int64 {
	mu.Lock()
	defer mu.Unlock()

	chID, ok := userToChannel[userID]
	if !ok {
		return 0
	}

	if users, exists := channelUsers[chID]; exists {
		delete(users, userID)
	}
	delete(userToChannel, userID)
	return chID
}

func GetUsers(channelID int64) []*ConnectedUser {
	mu.RLock()
	defer mu.RUnlock()

	users := channelUsers[channelID]
	result := make([]*ConnectedUser, 0, len(users))
	for _, u := range users {
		result = append(result, u)
	}
	return result
}

func GetUserChannel(userID int64) int64 {
	mu.RLock()
	defer mu.RUnlock()
	return userToChannel[userID]
}

func SetMuted(userID int64, muted bool) {
	mu.Lock()
	defer mu.Unlock()

	chID, ok := userToChannel[userID]
	if !ok {
		return
	}
	if u, exists := channelUsers[chID][userID]; exists {
		u.Muted = muted
	}
}

func SetSpeaking(userID int64, speaking bool) {
	mu.Lock()
	defer mu.Unlock()

	chID, ok := userToChannel[userID]
	if !ok {
		return
	}
	if u, exists := channelUsers[chID][userID]; exists {
		u.Speaking = speaking
	}
}

func GetAllChannelStates() map[int64][]*ConnectedUser {
	mu.RLock()
	defer mu.RUnlock()

	result := make(map[int64][]*ConnectedUser)
	for chID, users := range channelUsers {
		list := make([]*ConnectedUser, 0, len(users))
		for _, u := range users {
			list = append(list, u)
		}
		result[chID] = list
	}
	return result
}
