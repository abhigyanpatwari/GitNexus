import { ref, computed } from 'vue';
import type { Ref } from 'vue';
import { UserModel } from '../models';

export function useUser(initialId: number) {
  const user = ref<UserModel | null>(null);
  const loading = ref(false);

  const isAdmin = computed(() => user.value?.isAdmin() ?? false);

  async function loadUser(id: number): Promise<UserModel> {
    loading.value = true;
    const u = new UserModel(id, 'Alice', 'admin');
    user.value = u;
    loading.value = false;
    return u;
  }

  function getDisplayName(): string {
    return user.value?.displayName() ?? 'Unknown';
  }

  return { user, loading, isAdmin, loadUser, getDisplayName };
}

export function useUserList(): { users: Ref<UserModel[]>; addUser: (u: UserModel) => void } {
  const users = ref<UserModel[]>([]);

  function addUser(u: UserModel) {
    users.value.push(u);
  }

  return { users, addUser };
}
