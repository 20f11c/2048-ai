package main

/*
#cgo LDFLAGS: /workspace/zig-out/lib2048.so
#include "lib.h"
*/
import "C"
import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
)

type SearchRequest struct {
	Board  uint64 `json:"board,omitempty"`
	Cells  []uint32 `json:"cells,omitempty"`
}

type SearchResponse struct {
	Direction int    `json:"direction"`
	Board    uint64 `json:"board,omitempty"`
}

func cellsToBoard(cells []uint32) uint64 {
	if len(cells) != 16 {
		return 0
	}
	var data uint64 = 0
	for _, val := range cells {
		var rank uint64
		if val == 0 {
			rank = 0
		} else {
			// rank = log2(val)
			rank = 0
			v := val
			for v > 1 {
				v >>= 1
				rank++
			}
		}
		data = (data << 4) | rank
	}
	return data
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// 尝试简单解析 board 字段
		body := make([]byte, 32*1024)
		n, _ := r.Body.Read(body)
		body = body[:n]
		
		if idx := strings.Index(string(body), "\"board\""); idx >= 0 {
			rest := strings.TrimSpace(string(body)[idx+7:])
			i := 0
			for i < len(rest) && (rest[i] == ' ' || rest[i] == '\t' || rest[i] == ':' || rest[i] == '"') {
				i++
			}
			j := i
			for j < len(rest) && rest[j] >= '0' && rest[j] <= '9' {
				j++
			}
			if v, err := strconv.ParseUint(rest[i:j], 10, 64); err == nil {
				req.Board = v
			}
		}
		
		if req.Board == 0 {
			http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
			return
		}
	}

	var boardData uint64
	if req.Board != 0 {
		boardData = req.Board
	} else if len(req.Cells) > 0 {
		boardData = cellsToBoard(req.Cells)
	} else {
		http.Error(w, `{"error":"need board or cells"}`, http.StatusBadRequest)
		return
	}

	// 调用 Zig 动态库
	dir := int(C.search(C.ulonglong(boardData)))

	resp := SearchResponse{
		Direction: dir,
		Board:    boardData,
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	json.NewEncoder(w).Encode(resp)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	fmt.Fprintf(w, `{"status":"ok","version":"1.0.0"}`)
}

func handleOptions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.WriteHeader(http.StatusNoContent)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	// 设置动态库搜索路径
	// 或者确保 lib2048.so 在系统搜索路径中

	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/search", handleSearch)
	http.HandleFunc("/options", handleOptions)

	// 处理 CORS 预检请求
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			handleOptions(w, r)
			return
		}
		if r.URL.Path == "/health" {
			handleHealth(w, r)
			return
		}
		if r.URL.Path == "/search" {
			handleSearch(w, r)
			return
		}
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	})

	log.Printf("2048 AI HTTP Server listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
