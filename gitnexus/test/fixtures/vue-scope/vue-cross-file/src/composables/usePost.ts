import { ref } from 'vue';
import { PostModel } from '../models';

export function usePost() {
  const post = ref<PostModel | null>(null);

  function loadPost(id: number): PostModel {
    const p = new PostModel(id, 'Hello World', 'Content here', 1);
    post.value = p;
    return p;
  }

  function getSummary(): string {
    return post.value?.summary() ?? '';
  }

  return { post, loadPost, getSummary };
}
