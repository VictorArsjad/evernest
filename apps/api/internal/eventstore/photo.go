package eventstore

import (
	"encoding/base64"
	"net/http"
	"strconv"
)

// maxPhotoBytes caps a single raw image at 2 MB after base64-decode. The FE
// compresses to ~150–400 KB before sending, so this is defence in depth.
const maxPhotoBytes = 2 * 1024 * 1024

// allowedPhotoMimes mirrors the *_photo_mime_chk constraints on the diapers,
// notes and solid_meals tables. Keep in sync if that list changes.
var allowedPhotoMimes = map[string]struct{}{
	"image/jpeg": {},
	"image/png":  {},
	"image/webp": {},
}

type decodedPhoto struct {
	bytes []byte
	mime  *string
}

// decodePhoto turns the wire form (base64 string + mime) into what the SQL
// stores. Problems:
//   - 422 validation_failed: photo present but mime missing/unsupported, or
//     mime present without photo.
//   - 400 bad_request:       photo isn't valid base64.
//   - 413 payload_too_large: decoded image exceeds maxPhotoBytes.
//
// A nil photo and nil mime is "no photo attached": zero value, no problem.
func decodePhoto(photo *string, mime *string) (decodedPhoto, *Problem) {
	if photo == nil && mime == nil {
		return decodedPhoto{}, nil
	}
	if photo == nil || *photo == "" {
		return decodedPhoto{}, Invalid("photo_mime set without photo")
	}
	if mime == nil || *mime == "" {
		return decodedPhoto{}, Invalid("photo set without photo_mime")
	}
	if _, ok := allowedPhotoMimes[*mime]; !ok {
		return decodedPhoto{}, Invalid("unsupported photo_mime")
	}
	b, err := base64.StdEncoding.DecodeString(*photo)
	if err != nil {
		return decodedPhoto{}, &Problem{http.StatusBadRequest, "bad_request", "photo is not valid base64"}
	}
	if len(b) == 0 {
		return decodedPhoto{}, Invalid("photo decoded to empty bytes")
	}
	if len(b) > maxPhotoBytes {
		return decodedPhoto{}, &Problem{http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds size limit"}
	}
	m := *mime
	return decodedPhoto{bytes: b, mime: &m}, nil
}

// photo streams the raw image bytes. 404 if the row doesn't exist, 204 if it
// exists without a photo. Cache-Control private/300s: photos are effectively
// immutable for the life of the row, and 5 minutes of staleness balances
// "user just edited" against list pages re-fetching the same image.
func (h *Handler[T]) photo(w http.ResponseWriter, r *http.Request) {
	var (
		data []byte
		mime *string
	)
	if _, ok := h.itemScope(w, r, false, "photo, photo_mime", &data, &mime); !ok {
		return
	}
	if len(data) == 0 || mime == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", *mime)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "private, max-age=300")
	if _, err := w.Write(data); err != nil {
		h.logger.Warn("write "+h.spec.Noun+" photo", "err", err)
	}
}
