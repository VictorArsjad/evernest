package eventstore

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"

	"github.com/go-playground/validator/v10"
)

// Optional is a PATCH field with JSON Merge Patch (RFC 7396) semantics:
//
//	key absent   → Set=false            keep the stored value
//	"key": null  → Set=true, Null=true  clear (SQL NULL)
//	"key": v     → Set=true, Value=v    replace
//
// Use it for every nullable column a PATCH may clear. Fields that are NOT
// Optional reject an explicit null with 422 (see rejectNulls). Validation
// rules go in a `check:"..."` struct tag, not `validate`: the validator
// can't see through the wrapper, so decodeBody runs the tag on Value
// whenever a value is present.
type Optional[T any] struct {
	Set   bool
	Null  bool
	Value T
}

func (o *Optional[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.Value)
}

// Ptr is the value the row ends up with when the current one is cur:
// untouched → cur, null → nil, value → &Value.
func (o Optional[T]) Ptr(cur *T) *T {
	switch {
	case !o.Set:
		return cur
	case o.Null:
		return nil
	}
	v := o.Value
	return &v
}

// sqlArg is the (present, value) pair Set.Nullable binds; value is nil for
// null so the placeholder carries SQL NULL.
func (o Optional[T]) sqlArg() (bool, any) {
	if !o.Set || o.Null {
		return o.Set, nil
	}
	return true, o.Value
}

// optionalField is implemented by every Optional[T].
type optionalField interface {
	checkValue(v *validator.Validate, tag string) error
}

func (o Optional[T]) checkValue(v *validator.Validate, tag string) error {
	if !o.Set || o.Null {
		return nil
	}
	return v.Var(o.Value, tag)
}

var optionalType = reflect.TypeOf((*optionalField)(nil)).Elem()

// validateOptionals runs each Optional field's `check` tag on its value.
func validateOptionals(v *validator.Validate, dst any) error {
	var firstErr error
	walkFields(reflect.ValueOf(dst), func(f reflect.StructField, fv reflect.Value) {
		tag := f.Tag.Get("check")
		if tag == "" || firstErr != nil {
			return
		}
		if of, ok := fv.Interface().(optionalField); ok {
			if err := of.checkValue(v, tag); err != nil {
				firstErr = &fieldError{name: jsonName(f), err: err}
			}
		}
	})
	return firstErr
}

type fieldError struct {
	name string
	err  error
}

func (e *fieldError) Error() string { return e.name + ": " + e.err.Error() }

// rejectNulls returns the JSON name of the first body key that is an
// explicit null on a field that is not Optional (those can't be cleared).
func rejectNulls(raw []byte, dst any) (string, bool) {
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil {
		return "", false
	}
	clearable := map[string]bool{}
	walkFields(reflect.ValueOf(dst), func(f reflect.StructField, fv reflect.Value) {
		if fv.Type().Implements(optionalType) {
			clearable[jsonName(f)] = true
		}
	})
	for k, v := range keys {
		if bytes.Equal(bytes.TrimSpace(v), []byte("null")) && !clearable[k] {
			return k, true
		}
	}
	return "", false
}

// walkFields visits the exported fields of a struct pointer, descending into
// embedded structs. fv is addressable so pointer-receiver methods resolve.
func walkFields(v reflect.Value, fn func(reflect.StructField, reflect.Value)) {
	v = reflect.Indirect(v)
	if v.Kind() != reflect.Struct {
		return
	}
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		fv := v.Field(i)
		if f.Anonymous && fv.Kind() == reflect.Struct {
			walkFields(fv, fn)
			continue
		}
		if f.IsExported() {
			fn(f, fv)
		}
	}
}

func jsonName(f reflect.StructField) string {
	name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
	if name == "" {
		return f.Name
	}
	return name
}
