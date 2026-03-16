defmodule MyServer do
  use GenServer
  @behaviour Serializable
  @behaviour :gen_server

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(:get, _from, state) do
    {:reply, state, state}
  end

  @impl Serializable
  def serialize(term) do
    :erlang.term_to_binary(term)
  end
end

defprotocol Printable do
  @spec print(t()) :: String.t()
  def print(data)
end

defimpl Printable, for: MyServer do
  def print(server) do
    inspect(server)
  end
end
