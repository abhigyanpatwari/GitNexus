module PrependedOverride
  def serialize
    "prepended"
  end

  # Unique method name not defined elsewhere in the fixture. Calling this
  # from Account proves the prepend heritage edge adds PrependedOverride to
  # the MRO at all. Shadowed-name resolution (prepend > self) is deferred —
  # see plan 001's "Deferred to Separate Tasks: Ruby MRO kind-ordering".
  def prepended_marker
    "prepended-only"
  end
end
