package app

import models.UserFactory

object App {
  def main(args: Array[String]): Unit = {
    val user = UserFactory.create("alice")
  }
}
