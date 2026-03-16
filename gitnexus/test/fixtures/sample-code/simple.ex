defmodule MyApp.Accounts.User do
  @moduledoc "User account management"
  @behaviour GenServer

  alias MyApp.Repo
  import Ecto.Query
  require Logger
  use GenServer

  @type t :: %__MODULE__{name: String.t(), age: integer()}

  defstruct [:name, :age]

  @spec create(map()) :: {:ok, t()} | {:error, term()}
  def create(attrs) do
    attrs
    |> validate()
    |> Repo.insert()
  end

  defp validate(attrs) do
    attrs
  end

  defmacro my_macro(expr) do
    quote do
      unquote(expr)
    end
  end

  defguard is_positive(x) when is_integer(x) and x > 0
end

defprotocol Printable do
  @spec print(t()) :: String.t()
  def print(data)
end

defimpl Printable, for: MyApp.Accounts.User do
  def print(user) do
    user.name
  end
end
