# GitNexus Deployment Guide

## 🚀 Deploying to Vercel

### Quick Start (Recommended)

1. **Push your code to GitHub**
   ```bash
   git add .
   git commit -m "Prepare for deployment"
   git push origin main
   ```

2. **Deploy via Vercel Dashboard**
   - Go to [vercel.com](https://vercel.com) and sign in
   - Click "New Project"
   - Import your GitHub repository
   - Vercel will auto-detect it's a Vite project
   - Click "Deploy"

### Manual Deployment

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel**
   ```bash
   vercel login
   ```

3. **Deploy from your project directory**
   ```bash
   vercel
   ```

4. **Follow the prompts:**
   - Set up and deploy? `Y`
   - Which scope? `[Your account]`
   - Link to existing project? `N`
   - Project name: `gitnexus` (or your preferred name)
   - Directory: `./` (current directory)
   - Override settings? `N`

### Environment Variables

Set these in your Vercel project dashboard under Settings → Environment Variables:

```env
# Optional: Pre-configure API keys for users
VITE_OPENAI_API_KEY=sk-...
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_GEMINI_API_KEY=...

# Performance settings
VITE_DEFAULT_MAX_FILES=500
VITE_ENABLE_DEBUG_LOGGING=false
```

### Build Configuration

The `vercel.json` file is already configured with:

- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **Framework**: `vite`
- **WASM Support**: Proper headers for WebAssembly files
- **CORS Headers**: Required for SharedArrayBuffer support

### Custom Domain (Optional)

1. Go to your Vercel project dashboard
2. Navigate to Settings → Domains
3. Add your custom domain
4. Update DNS records as instructed

### Deployment Verification

After deployment, verify:

1. **Homepage loads** - Should show the GitNexus interface
2. **WASM files load** - Check browser console for WASM loading errors
3. **GitHub integration works** - Test repository analysis
4. **AI features work** - Test chat interface (if API keys configured)

### Troubleshooting

#### Build Failures

**Error**: "Module not found" or TypeScript errors
```bash
# Fix locally first
npm run build
# If successful locally, the issue is resolved
```

**Error**: WASM files not found
- Ensure `public/wasm/` directory is included in your repository
- Check that WASM files are not gitignored

#### Runtime Issues

**Error**: "SharedArrayBuffer not available"
- This is expected in development
- Vercel automatically sets the required CORS headers

**Error**: "Cross-origin isolation required"
- The `vercel.json` headers should handle this
- If issues persist, check browser console for specific errors

#### Performance Issues

**Slow loading**: 
- Check bundle size in Vercel dashboard
- Consider code splitting for large dependencies
- Optimize WASM file loading

### Monitoring & Analytics

1. **Vercel Analytics** (Optional)
   ```bash
   npm install @vercel/analytics
   ```

2. **Add to your app**:
   ```typescript
   import { Analytics } from '@vercel/analytics/react';
   
   function App() {
     return (
       <>
         {/* Your app content */}
         <Analytics />
       </>
     );
   }
   ```

### Continuous Deployment

Vercel automatically deploys on:
- Push to `main` branch → Production
- Push to other branches → Preview deployments
- Pull requests → Preview deployments

### Rollback

If you need to rollback:
1. Go to Vercel dashboard
2. Navigate to Deployments
3. Find the working deployment
4. Click "Promote to Production"

### Security Considerations

- API keys in environment variables are secure
- Client-side code is public (as expected for this app)
- No server-side secrets are exposed
- WASM files are served as static assets

### Cost Optimization

Vercel Hobby Plan (Free) includes:
- 100GB bandwidth/month
- 100GB storage
- 100GB function execution time
- Custom domains
- Automatic HTTPS

For higher usage, consider Vercel Pro ($20/month).

## 🎯 Next Steps

1. **Deploy your first version**
2. **Test all features thoroughly**
3. **Set up monitoring** (optional)
4. **Configure custom domain** (optional)
5. **Set up environment variables** for AI features

Your GitNexus application is now ready for production deployment! 🚀

