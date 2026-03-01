package main

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"
	"fmt"
	"strconv"
	"time"

	"github.com/kidandcat/vocipher/internal/auth"
	"github.com/kidandcat/vocipher/internal/channel"
	"github.com/kidandcat/vocipher/internal/database"
	"github.com/kidandcat/vocipher/internal/signaling"
)

var templates map[string]*template.Template
var cacheBust = fmt.Sprintf("%d", time.Now().Unix())

func loadTemplates() map[string]*template.Template {
	layoutFile := filepath.Join("web", "templates", "layout.html")
	pages := []string{"login.html", "register.html", "app.html"}
	t := make(map[string]*template.Template, len(pages))
	for _, page := range pages {
		t[page] = template.Must(template.ParseFiles(layoutFile, filepath.Join("web", "templates", page)))
	}
	return t
}

func main() {
	database.Init("vocipher.db")

	templates = loadTemplates()

	mux := http.NewServeMux()

	// Static files
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))

	// Auth routes
	mux.HandleFunc("/login", handleLogin)
	mux.HandleFunc("/register", handleRegister)
	mux.HandleFunc("/logout", handleLogout)

	// App routes (auth required)
	mux.HandleFunc("/", requireAuth(handleApp))
	mux.HandleFunc("/channels", requireAuth(handleChannels))
	mux.HandleFunc("/channels/delete", requireAuth(handleDeleteChannel))

	// WebSocket
	mux.HandleFunc("/ws", signaling.HandleWebSocket)

	addr := ":8090"
	log.Printf("Vocipher server starting on http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := auth.UserFromRequest(r)
		if user == nil {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		r.Header.Set("X-User-ID", strconv.FormatInt(user.ID, 10))
		r.Header.Set("X-Username", user.Username)
		next(w, r)
	}
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		if auth.UserFromRequest(r) != nil {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		templates["login.html"].ExecuteTemplate(w, "layout.html", nil)
		return
	}

	username := r.FormValue("username")
	password := r.FormValue("password")

	user, err := auth.Login(username, password)
	if err != nil {
		templates["login.html"].ExecuteTemplate(w, "layout.html", map[string]string{"Error": "Invalid username or password"})
		return
	}

	token, err := auth.CreateSession(user.ID)
	if err != nil {
		templates["login.html"].ExecuteTemplate(w, "layout.html", map[string]string{"Error": "Something went wrong"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400 * 30,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		if auth.UserFromRequest(r) != nil {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		templates["register.html"].ExecuteTemplate(w, "layout.html", nil)
		return
	}

	username := r.FormValue("username")
	password := r.FormValue("password")

	if len(username) < 2 || len(password) < 4 {
		templates["register.html"].ExecuteTemplate(w, "layout.html", map[string]string{"Error": "Username must be at least 2 characters, password at least 4"})
		return
	}

	user, err := auth.Register(username, password)
	if err != nil {
		templates["register.html"].ExecuteTemplate(w, "layout.html", map[string]string{"Error": "Username already taken"})
		return
	}

	token, err := auth.CreateSession(user.ID)
	if err != nil {
		templates["register.html"].ExecuteTemplate(w, "layout.html", map[string]string{"Error": "Something went wrong"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400 * 30,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("session"); err == nil {
		auth.DeleteSession(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func handleApp(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	user := auth.UserFromRequest(r)
	channels, _ := channel.List()

	data := map[string]any{
		"User":      user,
		"Channels":  channels,
		"CacheBust": cacheBust,
	}
	templates["app.html"].ExecuteTemplate(w, "layout.html", data)
}

func handleChannels(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromRequest(r)

	if r.Method == http.MethodPost {
		name := r.FormValue("name")
		if name != "" {
			channel.Create(name, user.ID)
		}
	}

	channels, _ := channel.List()
	data := map[string]any{
		"User":     user,
		"Channels": channels,
	}

	// Return just the channel list partial for HTMX
	templates["app.html"].ExecuteTemplate(w, "channel-list", data)
}

func handleDeleteChannel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	idStr := r.FormValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	channel.Delete(id)

	user := auth.UserFromRequest(r)
	channels, _ := channel.List()
	data := map[string]any{
		"User":     user,
		"Channels": channels,
	}
	templates["app.html"].ExecuteTemplate(w, "channel-list", data)
}
