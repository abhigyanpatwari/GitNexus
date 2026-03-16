defmodule MyApp.User do
  alias MyApp.Repo

  def create(attrs) do
    Repo.insert(attrs)
  end
end
