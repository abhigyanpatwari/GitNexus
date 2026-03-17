package app

import com.example.{User => U}

object App {
  def main(args: Array[String]): Unit = {
    val u: U = new U("alice")
    u.save()
  }
}
