import { extend } from 'umi-request';

const request = extend({ credentials: 'include' });

export default request;
