defmodule MyApp.Service do
  alias MyApp.Repo

  def save(attrs) do
    Repo.insert(attrs)
  end
end
