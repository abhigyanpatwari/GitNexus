import models
import auth

u = models.User()
u.save()

a = auth.Admin()
a.login()

# Same-name cross-module disambiguation: both models and auth export User.
# moduleAliasMap maps receiverName='auth' → auth.py, enabling resolveCallTarget
# to narrow candidates to the correct file.
v = auth.User()
v.verify()
