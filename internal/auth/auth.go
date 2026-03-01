package auth

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"

	"github.com/kidandcat/vocipher/internal/database"
	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID       int64
	Username string
}

var (
	ErrUserExists  = errors.New("username already taken")
	ErrInvalidAuth = errors.New("invalid username or password")
)

func Register(username, password string) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	res, err := database.DB.Exec("INSERT INTO users (username, password_hash) VALUES (?, ?)", username, string(hash))
	if err != nil {
		return nil, ErrUserExists
	}

	id, _ := res.LastInsertId()
	return &User{ID: id, Username: username}, nil
}

func Login(username, password string) (*User, error) {
	var user User
	var hash string
	err := database.DB.QueryRow("SELECT id, username, password_hash FROM users WHERE username = ?", username).
		Scan(&user.ID, &user.Username, &hash)
	if err != nil {
		return nil, ErrInvalidAuth
	}

	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return nil, ErrInvalidAuth
	}

	return &user, nil
}

func CreateSession(userID int64) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)

	_, err := database.DB.Exec("INSERT INTO sessions (token, user_id) VALUES (?, ?)", token, userID)
	if err != nil {
		return "", err
	}

	return token, nil
}

func DeleteSession(token string) {
	database.DB.Exec("DELETE FROM sessions WHERE token = ?", token)
}

func UserFromRequest(r *http.Request) *User {
	cookie, err := r.Cookie("session")
	if err != nil {
		return nil
	}
	return UserFromToken(cookie.Value)
}

func UserFromToken(token string) *User {
	var user User
	err := database.DB.QueryRow(
		"SELECT u.id, u.username FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?", token,
	).Scan(&user.ID, &user.Username)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return nil
	}
	return &user
}
