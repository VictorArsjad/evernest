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

// sqlOptional is satisfied by every Optional[T].
type sqlOptional interface{ sqlArg() (set bool, v any) }

// Nullable applies a merge-patch Optional: absent → keep, null → NULL,
// value → replace. cast is the SQL type of the value.
func (s *Set) Nullable(col, cast string, o sqlOptional) *Set {
	set, v := o.sqlArg()
	return s.Optional(col, cast, set, v)
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

// Text applies merge-patch to nullable free text: absent keeps col, null or
// "" clears it, anything else replaces it.
func (s *Set) Text(col string, o Optional[string]) *Set {
	value := ""
	if o.Set && !o.Null {
		value = o.Value
	}
	c := s.arg(o.Set)
	p := s.arg(value)
	s.parts = append(s.parts, col+" = CASE WHEN "+c+"::boolean THEN NULLIF("+p+", '') ELSE "+col+" END")
	return s
}

// SQL is the comma-joined SET clause.
func (s *Set) SQL() string { return strings.Join(s.parts, ", ") }

// Args are the placeholder values in order.
func (s *Set) Args() []any { return s.args }
