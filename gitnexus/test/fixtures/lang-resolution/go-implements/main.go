// Issue #20 fixture: Go struct whose method set is a superset of an
// interface's method set. No explicit `implements` keyword; Go uses
// structural (duck) typing. The IMPLEMENTS edge should be detected by
// comparing the struct's method set against the interface's method set.
//
// M2 fixture: value-receiver methods are in the method set of BOTH T
// and *T (per the Go spec). Calculator uses a value receiver and must
// still satisfy Namer.
//
// M3 fixture: interface embedding — ReadCloser embeds Reader and Closer.
// A struct implementing both Reader AND Closer satisfies ReadCloser via
// promoted methods. We also assert that Reader and Closer each get an
// IMPLEMENTS edge on their own.
package goimplements

// Namer is a single-method interface.
type Namer interface {
	GetName() string
}

// User is a struct with a method that matches Namer.GetName by name.
// Because Go interfaces are satisfied implicitly, User implements Namer.
type User struct {
	Name string
}

// GetName satisfies Namer.
func (u *User) GetName() string {
	return u.Name
}

// MultiMethoder is a multi-method interface.
type MultiMethoder interface {
	GetName() string
	GetID() int
}

// Admin has both GetName and GetID — implements MultiMethoder.
type Admin struct {
	Name string
	ID   int
}

func (a *Admin) GetName() string {
	return a.Name
}

func (a *Admin) GetID() int {
	return a.ID
}

// Incomplete is a struct that does NOT implement Namer (no GetName method).
// It exists to verify that we don't emit a false-positive IMPLEMENTS edge.
type Incomplete struct {
	Name string
}

// ---------------------------------------------------------------------------
// M2: Value-receiver methods are in the method set of T AND *T.
// Calculator has a VALUE-receiver method `Sum`, and also a value-receiver
// method `GetName` so it can satisfy Namer as a value type.
// ---------------------------------------------------------------------------

// Calculator is a struct with a value-receiver method that matches Namer.
type Calculator struct {
	Base int
}

// GetName on value receiver — `Calculator` (T) and `*Calculator` (*T) both
// have this method in their method sets.
func (c Calculator) GetName() string {
	return "calculator"
}

// Sum is a value-receiver method unique to Calculator (no matching iface).
func (c Calculator) Sum() int {
	return c.Base * 2
}

// ---------------------------------------------------------------------------
// M3: Interface embedding — ReadCloser embeds Reader and Closer.
// A struct implementing only the leaf methods (Read, Close) satisfies
// ReadCloser via promoted-method inheritance.
// ---------------------------------------------------------------------------

// Reader is a single-method interface.
type Reader interface {
	Read(p []byte) (int, error)
}

// Closer is a single-method interface.
type Closer interface {
	Close() error
}

// ReadCloser embeds Reader and Closer. A struct implementing Read AND
// Close satisfies ReadCloser implicitly.
type ReadCloser interface {
	Reader
	Closer
}

// FileHandler implements both Read and Close, satisfying ReadCloser.
type FileHandler struct {
	Path string
}

func (f *FileHandler) Read(p []byte) (int, error) {
	return 0, nil
}

func (f *FileHandler) Close() error {
	return nil
}
