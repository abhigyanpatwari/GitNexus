package app

import models.User

object App {
  def main(args: Array[String]): Unit = {
    val user = new User()
    user.save()
  }
}
