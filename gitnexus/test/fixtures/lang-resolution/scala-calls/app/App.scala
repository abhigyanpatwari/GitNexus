package app

import util.Processor

object App {
  def main(args: Array[String]): Unit = {
    val processor: Processor = new Processor()
    processor.process("test")
  }
}
