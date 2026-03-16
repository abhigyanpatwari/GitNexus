defmodule Pipeline do
  def process(data) do
    data
    |> step_one()
    |> step_two()
    |> step_three()
  end

  defp step_one(data), do: data
  defp step_two(data), do: data
  defp step_three(data), do: data
end
