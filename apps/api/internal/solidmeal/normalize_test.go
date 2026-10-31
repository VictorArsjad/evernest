package solidmeal

import (
	"reflect"
	"testing"
)

func TestNormalizeFoods(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{name: "trim and drop empties", in: []string{" avocado ", "", "  ", "banana"}, want: []string{"avocado", "banana"}},
		{name: "keeps duplicates", in: []string{"egg", "egg"}, want: []string{"egg", "egg"}},
		{name: "all blank", in: []string{"", "  "}, want: []string{}},
		{name: "nil", in: nil, want: []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeFoods(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("normalizeFoods(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
