package e2ee

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

var testStreamKey = []byte("0123456789abcdef0123456789abcdef")

type testFrame struct {
	start      int
	end        int
	length     int
	flags      byte
	nonce      []byte
	ciphertext []byte
}

func splitTestFrames(t *testing.T, data []byte) ([]testFrame, int) {
	t.Helper()
	if len(data) < len(StreamMagic) || string(data[:len(StreamMagic)]) != StreamMagic {
		t.Fatalf("missing stream magic")
	}
	offset := len(StreamMagic)
	var frames []testFrame
	for offset < len(data) {
		if len(data)-offset < streamFrameHeader {
			t.Fatalf("short frame header at %d", offset)
		}
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		end := offset + streamFrameHeader + length
		if end > len(data) {
			t.Fatalf("frame length %d exceeds %d at %d", length, len(data), offset)
		}
		frames = append(frames, testFrame{
			start:      offset,
			end:        end,
			length:     length,
			flags:      data[offset+4],
			nonce:      append([]byte(nil), data[offset+5:offset+streamFrameHeader]...),
			ciphertext: append([]byte(nil), data[offset+streamFrameHeader:end]...),
		})
		offset = end
	}
	return frames, len(StreamMagic)
}

func frameBytes(data []byte, frame testFrame) []byte {
	return append([]byte(nil), data[frame.start:frame.end]...)
}

func joinTestFrames(magic []byte, frames ...[]byte) []byte {
	out := append([]byte(nil), magic...)
	for _, frame := range frames {
		out = append(out, frame...)
	}
	return out
}

func encryptTestStream(t *testing.T, plaintext []byte, purpose, nonce string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer, err := NewStreamWriter(&buf, testStreamKey, purpose, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if len(plaintext) > 0 {
		if _, err := writer.Write(plaintext); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func readTestStream(t *testing.T, ciphertext []byte, purpose, nonce string) ([]byte, error) {
	t.Helper()
	reader, err := NewStreamReader(bytes.NewReader(ciphertext), testStreamKey, purpose, nonce)
	if err != nil {
		return nil, err
	}
	plaintext, err := io.ReadAll(reader)
	return plaintext, err
}

func TestStreamRoundTrip(t *testing.T) {
	sizes := []int{
		0,
		1,
		StreamChunkSize - 1,
		StreamChunkSize,
		StreamChunkSize + 1,
		2 * StreamChunkSize,
		3*StreamChunkSize + 7,
	}
	for _, size := range sizes {
		t.Run(sizeName(size), func(t *testing.T) {
			plaintext := make([]byte, size)
			for i := range plaintext {
				plaintext[i] = byte(i%251 + 1)
			}
			var buf bytes.Buffer
			writer, err := NewStreamWriter(&buf, testStreamKey, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
			if err != nil {
				t.Fatal(err)
			}
			for offset := 0; offset < len(plaintext); {
				n := 100003
				if n > len(plaintext)-offset {
					n = len(plaintext) - offset
				}
				if _, err := writer.Write(plaintext[offset : offset+n]); err != nil {
					t.Fatal(err)
				}
				offset += n
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if got, want := int64(buf.Len()), EncryptedStreamLength(int64(size)); got != want {
				t.Fatalf("ciphertext length = %d, want %d", got, want)
			}
			reader, err := NewStreamReader(bytes.NewReader(buf.Bytes()), testStreamKey, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			if err := reader.Finish(); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, plaintext) {
				t.Fatalf("plaintext mismatch: got %d bytes, want %d", len(got), len(plaintext))
			}
		})
	}
}

func sizeName(size int) string {
	switch {
	case size == 0:
		return "empty"
	case size == StreamChunkSize:
		return "exact_chunk"
	case size == StreamChunkSize-1:
		return "chunk_minus_one"
	case size == StreamChunkSize+1:
		return "chunk_plus_one"
	default:
		return "size_" + itoa(size)
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	pos := len(digits)
	for value > 0 {
		pos--
		digits[pos] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[pos:])
}

func TestStreamWriterFrameLayout(t *testing.T) {
	plaintext := bytes.Repeat([]byte("A"), StreamChunkSize)
	ciphertext := encryptTestStream(t, plaintext, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
	frames, magicLen := splitTestFrames(t, ciphertext)
	if magicLen != len(StreamMagic) {
		t.Fatalf("magic length = %d", magicLen)
	}
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	if frames[0].flags != 0 || frames[0].length != StreamChunkSize+streamTagSize {
		t.Fatalf("first frame flags=%d length=%d", frames[0].flags, frames[0].length)
	}
	if frames[1].flags != streamFlagFinal || frames[1].length != streamTagSize {
		t.Fatalf("final frame flags=%d length=%d", frames[1].flags, frames[1].length)
	}

	empty := encryptTestStream(t, nil, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
	emptyFrames, _ := splitTestFrames(t, empty)
	if len(emptyFrames) != 1 || emptyFrames[0].flags != streamFlagFinal || emptyFrames[0].length != streamTagSize {
		t.Fatalf("empty stream frames = %+v", emptyFrames)
	}
}

func TestStreamDecryptsWebFixture(t *testing.T) {
	fixture, err := base64.StdEncoding.DecodeString("TUZTQzEAAAAtAfyjX08ausLOt8/psX8C406KxkxukKGwEZeu9d+H2im5q8IgCBQXhmQlY5yKrWowg5TgdDeo0Z0eAQ==")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := NewStreamReader(bytes.NewReader(fixture), testStreamKey, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Finish(); err != nil {
		t.Fatal(err)
	}
	if string(got) != "cross-language stream fixture" {
		t.Fatalf("fixture plaintext = %q", got)
	}
}

func TestStreamRoundTripWithTinyWrites(t *testing.T) {
	plaintext := []byte("hello chunked world, 你好")
	var buf bytes.Buffer
	writer, err := NewStreamWriter(&buf, testStreamKey, StreamPurposeDownload, "abcdefghijklmnop")
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range plaintext {
		if _, err := writer.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := readTestStream(t, buf.Bytes(), StreamPurposeDownload, "abcdefghijklmnop")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("plaintext = %q", got)
	}
}

func TestStreamReaderRejectsTampering(t *testing.T) {
	plaintext := bytes.Repeat([]byte("frame data "), 300000)
	purpose := StreamPurposeDownload
	nonce := "MDEyMzQ1Njc4OWFiY2RlZg"
	ciphertext := encryptTestStream(t, plaintext, purpose, nonce)
	frames, magicLen := splitTestFrames(t, ciphertext)
	if len(frames) < 2 {
		t.Fatalf("expected multiple frames, got %d", len(frames))
	}
	magic := ciphertext[:magicLen]

	assertInvalid := func(name string, data []byte) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			_, err := readTestStream(t, data, purpose, nonce)
			if err == nil {
				t.Fatal("expected stream rejection")
			}
			if !errors.Is(err, ErrStreamInvalid) {
				t.Fatalf("error = %v, want ErrStreamInvalid", err)
			}
		})
	}

	magicTampered := append([]byte(nil), ciphertext...)
	magicTampered[0] ^= 0xff
	assertInvalid("magic", magicTampered)

	flagsTampered := append([]byte(nil), ciphertext...)
	flagsTampered[frames[0].start+4] ^= streamFlagFinal
	assertInvalid("flags", flagsTampered)

	lengthTampered := append([]byte(nil), ciphertext...)
	binary.BigEndian.PutUint32(lengthTampered[frames[0].start:frames[0].start+4], uint32(frames[0].length+1))
	assertInvalid("length", lengthTampered)

	nonceTampered := append([]byte(nil), ciphertext...)
	nonceTampered[frames[0].start+5] ^= 0xff
	assertInvalid("frame_nonce", nonceTampered)

	cipherTampered := append([]byte(nil), ciphertext...)
	cipherTampered[frames[0].start+streamFrameHeader] ^= 0xff
	assertInvalid("ciphertext", cipherTampered)

	truncated := append([]byte(nil), ciphertext[:len(ciphertext)-1]...)
	assertInvalid("truncated_ciphertext", truncated)

	droppedFinal := joinTestFrames(magic, frameBytes(ciphertext, frames[0]))
	assertInvalid("missing_final", droppedFinal)

	reordered := joinTestFrames(magic, frameBytes(ciphertext, frames[1]))
	for _, frame := range frames[2:] {
		reordered = joinTestFrames(reordered, frameBytes(ciphertext, frame))
	}
	reordered = joinTestFrames(reordered, frameBytes(ciphertext, frames[0]))
	assertInvalid("reordered", reordered)

	duplicated := joinTestFrames(magic, frameBytes(ciphertext, frames[0]))
	for _, frame := range frames {
		duplicated = joinTestFrames(duplicated, frameBytes(ciphertext, frame))
	}
	assertInvalid("duplicated", duplicated)

	withTrailing := append(append([]byte(nil), ciphertext...), 0)
	assertInvalid("trailing", withTrailing)

	_, err := readTestStream(t, ciphertext, purpose, "abcdefghijklmnop")
	if err == nil {
		t.Fatal("expected wrong request nonce rejection")
	}
	_, err = readTestStream(t, ciphertext, StreamPurposeUpload, nonce)
	if err == nil {
		t.Fatal("expected wrong purpose rejection")
	}
	wrongKeyReader, err := NewStreamReader(bytes.NewReader(ciphertext), []byte("ffffffffffffffffffffffffffffffff"), purpose, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(wrongKeyReader); err == nil {
		t.Fatal("expected wrong key rejection")
	}
}

func TestStreamFinishRequiresFinalFrame(t *testing.T) {
	plaintext := bytes.Repeat([]byte("finish "), StreamChunkSize/7)
	ciphertext := encryptTestStream(t, plaintext, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
	frames, magicLen := splitTestFrames(t, ciphertext)
	missingFinal := joinTestFrames(ciphertext[:magicLen])
	for _, frame := range frames[:len(frames)-1] {
		missingFinal = joinTestFrames(missingFinal, frameBytes(ciphertext, frame))
	}
	reader, err := NewStreamReader(bytes.NewReader(missingFinal), testStreamKey, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Finish(); err == nil {
		t.Fatal("expected missing final frame rejection")
	}
}

func TestStreamReaderRejectsEmptyNonFinalFrame(t *testing.T) {
	ciphertext := encryptTestStream(t, nil, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
	// Convert the final empty frame into a non-final empty frame.
	ciphertext[len(StreamMagic)+4] &^= streamFlagFinal
	reader, err := NewStreamReader(bytes.NewReader(ciphertext), testStreamKey, StreamPurposeUpload, "MDEyMzQ1Njc4OWFiY2RlZg")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(reader); err == nil {
		t.Fatal("expected empty non-final frame rejection")
	}
}
