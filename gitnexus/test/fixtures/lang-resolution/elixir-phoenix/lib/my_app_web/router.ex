defmodule MyAppWeb.Router do
  use Phoenix.Router

  scope "/", MyAppWeb do
    get "/users", UserController, :index
    get "/users/:id", UserController, :show
  end
end
