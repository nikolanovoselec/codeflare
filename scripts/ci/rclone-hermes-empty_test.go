package s3

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
)

// Strict egress reattaches SSE-C unless the scoped fallback opts out. The
// provider rejects SSE-C on a plain object; only verified empty reads can pass.
func TestCodeflareHermesEmptyRead(t *testing.T) {
	backend, err := fs.Find("s3")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, optIn, head, body string
		headOK, getOK           bool
	}{
		{"empty", "1", "", "", true, true},
		{"not opted in", "", "", "", false, false},
		{"plain nonempty", "1", "x", "x", false, false},
		{"changed after HEAD", "1", "", "x", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CODEFLARE_RCLONE_HERMES_EMPTY_READ", tc.optIn)
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/bucket/memory.md" {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				if r.Header.Get("X-Amz-Server-Side-Encryption-Customer-Key") != "" ||
					r.Header.Get("X-Codeflare-Hermes-Empty-Read") != "1" {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				body := tc.body
				if r.Method == http.MethodHead {
					body = tc.head
				}
				w.Header().Set("Content-Length", strconv.Itoa(len(body)))
				w.Header().Set("ETag", `"00000000000000000000000000000000"`)
				w.Header().Set("Last-Modified", "Sun, 22 Nov 2026 13:00:00 GMT")
				w.WriteHeader(http.StatusOK)
				if r.Method != http.MethodHead {
					_, _ = io.WriteString(w, body)
				}
			}))
			defer peer.Close()
			ctx := context.Background()
			// Use the same registered backend defaults as a normal remote.
			config := fs.ConfigMap(backend.Prefix, backend.Options, "fixture", configmap.Simple{
				"provider": "Cloudflare", "endpoint": peer.URL, "force_path_style": "true", "no_check_bucket": "true",
				"access_key_id": "fixture", "secret_access_key": "fixture", "sse_customer_algorithm": "AES256",
				"sse_customer_key_base64": base64.StdEncoding.EncodeToString(make([]byte, 32)),
			})
			remote, err := backend.NewFs(ctx, "fixture", "bucket", config)
			if err != nil {
				t.Fatal(err)
			}
			obj, err := remote.NewObject(ctx, "memory.md")
			if (err == nil) != tc.headOK {
				t.Fatalf("HEAD: want success %t, got %v", tc.headOK, err)
			}
			if err != nil {
				return
			}
			reader, err := obj.Open(ctx)
			if (err == nil) != tc.getOK {
				t.Fatalf("GET: want success %t, got %v", tc.getOK, err)
			}
			if err == nil {
				defer reader.Close()
				data, err := io.ReadAll(reader)
				if err != nil || len(data) != 0 {
					t.Fatalf("expected empty read, got %d bytes and error %v", len(data), err)
				}
			}
		})
	}
}
