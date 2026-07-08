using App.Domain;
using DomainAlias = App.Domain;

namespace App
{
    // Each declaration below exercises a base-list shape an earlier inheritance
    // synth DROPPED before #1951. Scope-resolution (the single path since #942)
    // now covers them all.

    // record_declaration base_list, plain identifier bases (record traversal
    // was skipped — synth only walked class/interface declarations).
    public record R(int x) : Base, IFoo
    {
        public void Foo() { }
    }

    // record_declaration with a primary_constructor_base_type (`Base(id)`): the
    // base-name extractor had no case for primary_constructor_base_type and
    // returned null, dropping the EXTENDS edge. Its `type` field is the
    // supertype; the trailing argument_list is normalized away → `Base`.
    public record P(int id) : Base(id), IBar
    {
        public void Bar() { }
    }

    // struct_declaration base_list with a qualified_name base (`App.Domain.IBar`
    // → `IBar`). Struct traversal was skipped before #1951.
    public struct S : IFoo, App.Domain.IBar
    {
        public void Foo() { }
        public void Bar() { }
    }

    // qualified_name base on a class — already handled; pinned as a regression
    // guard so the simple/qualified path stays byte-identical.
    public class A : App.Domain.Base
    {
    }

    // alias_qualified_name base (`DomainAlias::Base` → `Base`): an earlier
    // extractor had no case for alias_qualified_name and returned null. Its
    // `name` field is the bare identifier; scope-resolution reduces it the same way.
    public class B : DomainAlias::Base
    {
    }
}
