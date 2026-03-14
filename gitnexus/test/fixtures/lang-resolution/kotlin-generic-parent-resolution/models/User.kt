package models

class User : BaseModel<String>() {
    override fun save(): Boolean {
        super.save()
        return true
    }
}
