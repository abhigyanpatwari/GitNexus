package app

import models.Handler

object App {
  def run(): Unit = {
    val handler: Handler = new Handler()
    handler.process()
  }
}
