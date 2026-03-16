defmodule Serializable do
  @callback serialize(term()) :: binary()
end
