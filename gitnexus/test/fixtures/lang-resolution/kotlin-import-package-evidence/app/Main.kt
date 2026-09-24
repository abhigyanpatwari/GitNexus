package app

import com.example.real.User
import com.example.real.loadUser
import com.example.tools.Tools.format
import org.junit.Assert

fun run() {
    val user = User()
    user.save()
    loadUser()
    format()
}
