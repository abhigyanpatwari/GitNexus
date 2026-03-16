defmodule MyAppWeb.UserLive do
  use Phoenix.LiveView

  def mount(_params, _session, socket) do
    {:ok, assign(socket, :users, [])}
  end

  def handle_event("delete", %{"id" => id}, socket) do
    {:noreply, socket}
  end
end
