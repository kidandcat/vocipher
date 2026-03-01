.PHONY: run build clean

run:
	CGO_ENABLED=1 go run ./cmd/server/

build:
	CGO_ENABLED=1 go build -o vocipher ./cmd/server/

clean:
	rm -f vocipher vocipher.db vocipher.db-wal vocipher.db-shm
