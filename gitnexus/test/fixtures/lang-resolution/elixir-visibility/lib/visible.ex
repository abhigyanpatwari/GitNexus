defmodule Visible do
  def public_func(x), do: x

  defp private_func(x), do: x

  defmacro public_macro(expr) do
    quote do: unquote(expr)
  end

  defmacrop private_macro(expr) do
    quote do: unquote(expr)
  end
end
