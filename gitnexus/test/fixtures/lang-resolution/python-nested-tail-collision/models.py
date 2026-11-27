class UserForm:
    class Meta:
        fields = ['username', 'email']

    def clean_username(self):
        pass


class PostForm:
    class Meta:
        fields = ['title', 'body']

    def clean_title(self):
        pass
