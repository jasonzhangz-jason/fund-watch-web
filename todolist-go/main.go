package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Task struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	Done      bool      `json:"done"`
	CreatedAt time.Time `json:"createdAt"`
}

type Store struct {
	mu     sync.Mutex
	path   string
	tasks  []Task
	nextID int64
}

func newStore(path string) (*Store, error) {
	s := &Store{path: path, tasks: []Task{}, nextID: 1}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, &s.tasks); err != nil {
		return nil, err
	}
	for _, task := range s.tasks {
		if task.ID >= s.nextID {
			s.nextID = task.ID + 1
		}
	}
	return s, nil
}

func (s *Store) save() error {
	data, err := json.MarshalIndent(s.tasks, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) list() []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Task{}, s.tasks...)
}

func (s *Store) create(title string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task := Task{ID: s.nextID, Title: title, CreatedAt: time.Now().UTC()}
	s.nextID++
	s.tasks = append(s.tasks, task)
	if err := s.save(); err != nil {
		s.tasks = s.tasks[:len(s.tasks)-1]
		s.nextID--
		return Task{}, err
	}
	return task, nil
}

func (s *Store) update(id int64, title *string, done *bool) (Task, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.tasks {
		if s.tasks[i].ID != id {
			continue
		}
		previous := s.tasks[i]
		if title != nil {
			s.tasks[i].Title = *title
		}
		if done != nil {
			s.tasks[i].Done = *done
		}
		if err := s.save(); err != nil {
			s.tasks[i] = previous
			return Task{}, true, err
		}
		return s.tasks[i], true, nil
	}
	return Task{}, false, nil
}

func (s *Store) delete(id int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, task := range s.tasks {
		if task.ID == id {
			previous := append([]Task{}, s.tasks...)
			s.tasks = append(s.tasks[:i], s.tasks[i+1:]...)
			if err := s.save(); err != nil {
				s.tasks = previous
				return true, err
			}
			return true, nil
		}
	}
	return false, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func taskID(r *http.Request) (int64, error) {
	idText := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	var id int64
	_, err := fmt.Sscan(idText, &id)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid task id")
	}
	return id, nil
}

func main() {
	dataPath := os.Getenv("TODO_DATA")
	if dataPath == "" {
		dataPath = "data/tasks.json"
	}
	store, err := newStore(dataPath)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/tasks", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tasks" {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, store.list())
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			var input struct {
				Title string `json:"title"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求数据格式不正确"})
				return
			}
			input.Title = strings.TrimSpace(input.Title)
			if input.Title == "" || len([]rune(input.Title)) > 200 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "任务内容不能为空且不超过 200 个字符"})
				return
			}
			task, err := store.create(input.Title)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存失败"})
				return
			}
			writeJSON(w, http.StatusCreated, task)
		default:
			w.Header().Set("Allow", "GET, POST")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "不支持该请求方法"})
		}
	})
	mux.HandleFunc("/api/tasks/", func(w http.ResponseWriter, r *http.Request) {
		id, err := taskID(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "任务编号无效"})
			return
		}
		switch r.Method {
		case http.MethodPatch:
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			var input struct {
				Title *string `json:"title"`
				Done  *bool   `json:"done"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil || (input.Title == nil && input.Done == nil) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求数据格式不正确"})
				return
			}
			if input.Title != nil {
				trimmed := strings.TrimSpace(*input.Title)
				if trimmed == "" || len([]rune(trimmed)) > 200 {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "任务内容不能为空且不超过 200 个字符"})
					return
				}
				input.Title = &trimmed
			}
			task, found, err := store.update(id, input.Title, input.Done)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存失败"})
				return
			}
			if !found {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, http.StatusOK, task)
		case http.MethodDelete:
			found, err := store.delete(id)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存失败"})
				return
			}
			if !found {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Header().Set("Allow", "PATCH, DELETE")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "不支持该请求方法"})
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, "index.html")
	})

	addr := os.Getenv("TODO_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Printf("TodoList 已启动：http://localhost%s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, io.EOF) {
		log.Fatal(err)
	}
}
