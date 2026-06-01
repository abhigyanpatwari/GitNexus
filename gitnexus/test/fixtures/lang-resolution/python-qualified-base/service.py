import base_mod
import a.b
from base_mod import Container


# Qualified attribute base: `class Service(base_mod.Model)` parses the base as
# an `attribute` node (object `base_mod`, attribute `Model`). The synth resolves
# it by its trailing `.attribute` identifier -> `Model` (#1951).
class Service(base_mod.Model):
    pass


# Nested attribute base: `class Nested(a.b.Base)` parses as a nested `attribute`
# (object `a.b`, attribute `Base`). Recurse to the final identifier -> `Base`.
class Nested(a.b.Base):
    pass


# Generic subscript base: `class Gen(Container[str])` parses the base as a
# `subscript` node (`value:` `Container`, slice `str`). The synth strips the
# `[...]` via the `value:` field -> `Container`.
class Gen(Container[str]):
    pass


# Bare control: `class Plain(Container)` keeps the existing simple-identifier
# capture byte-identical.
class Plain(Container):
    pass
