import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';
import { UserListComponent } from './user-list.component';
import { UserDetailComponent } from './user-detail.component';
import { LazyModule } from './lazy.module';

export const ROUTES: Routes = [
  { path: '', component: HomeComponent },
  {
    path: 'users',
    component: UserListComponent,
    children: [
      { path: ':id', component: UserDetailComponent },
    ],
  },
  { path: 'lazy', loadChildren: () => import('./lazy.module').then((m) => m.LazyModule) },
  { path: 'redirect', redirectTo: 'users' },
];
