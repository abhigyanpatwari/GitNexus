defmodule MyApp.Service do
  alias MyApp.Accounts.{User, Admin}

  def list_users do
    [%User{name: "Alice"}, %Admin{name: "Bob", role: "admin"}]
  end
end
