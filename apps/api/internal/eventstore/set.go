package eventstore

import (
	"strconv"
	"strings"
)

// Set builds the SET clause and args of a PATCH, numbering placeholders itself
// so kinds never hand-count $n. $1 is the row id, so kind args start at $2.
type Set struct {
	next  int
	parts []string
	args  []any
}

// NewSet starts a Set whose first placeholder is $startIdx (2 for PATCH).
func NewSet(startIdx int) *Set { return &Set{next: startIdx} }

func (s *Set) arg(v any) string {
	p := "$" + strconv.Itoa(s.next)
	s.next++
	s.args = append(s.args, v)
	return p
}

// Assign sets col to v unconditionally.
func (s *Set) Assign(col string, v any) *Set {
	s.parts = append(s.parts, col+" = "+s.arg(v))
	return s
}

// Coalesce keeps col unless v is non-NULL.
func (s *Set) Coalesce(col string, v any) *Set {
	p := s.arg(v)
	s.parts = append(s.parts, col+" = COALESCE("+p+", "+col+")")
	return s
}

// Clearable: clear → NULL; non-NULL v → replace; else keep. cast is the SQL
// type of v.
func (s *Set) Clearable(col, cast string, clear bool, v any) *Set {
	c := s.arg(clear)
	p := s.arg(v)
	s.parts = append(s.parts, col+" = CASE WHEN "+c+"::boolean THEN NULL WHEN "+
		p+"::"+cast+" IS NOT NULL THEN "+p+" ELSE "+col+" END")
	return s
}

// Optional replaces col with v only when present, so v may itself be NULL or
// an empty array. cast is the SQL type of v ("" for none).
func (s *Set) Optional(col, cast string, present bool, v any) *Set {
	c := s.arg(present)
	p := s.arg(v)
	if cast != "" {
		p += "::" + cast
	}
	s.parts = append(s.parts, col+" = CASE WHEN "+c+"::boolean THEN "+p+" ELSE "+col+" END")
	return s
}

// Text applies the "present-flag + NULLIF(value,”)" PATCH convention for
// nullable text: Go's JSON decoder can't tell an absent field from an explicit
// null on a *string, so nil leaves col alone and "" clears it.
func (s *Set) Text(col string, v *string) *Set {
	present, value := false, ""
	if v != nil {
		present, value = true, *v
	}
	c := s.arg(present)
	p := s.arg(value)
	s.parts = append(s.parts, col+" = CASE WHEN "+c+"::boolean THEN NULLIF("+p+", '') ELSE "+col+" END")
	return s
}

// SQL is the comma-joined SET clause.
func (s *Set) SQL() string { return strings.Join(s.parts, ", ") }

// Args are the placeholder values in order.
func (s *Set) Args() []any { return s.args }
