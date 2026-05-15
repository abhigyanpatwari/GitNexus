defmodule MyApp.User do
  alias MyApp.Repo
  import Ecto.Query, only: [from: 2]
  use Phoenix.LiveView
  require Logger

  @behaviour MyApp.UserBehaviour

  def get(id) do
    Repo.get(MyApp.User, id)
  end

  def get_by_email(email) do
    from(u in MyApp.User, where: u.email == ^email)
    |> Repo.one()
  end

  defp validate(user) do
    user
  end

  def create(attrs) do
    %MyApp.User{}
    |> MyApp.User.changeset(attrs)
    |> Repo.insert()
  end
end

defmodule MyApp.UserProtocol do
  @doc "A protocol for user operations"
end

defprotocol MyApp.Serializable do
  def serialize(data)
end
