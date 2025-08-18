import { GitHubOptimizedService } from '../services/github-optimized.js';
import { HybridGitHubService } from '../services/hybrid-github.js';

// Test functions exposed globally for browser console testing
declare global {
  interface Window {
    testGitHubOptimized: () => Promise<void>;
    testHybridGitHub: () => Promise<void>;
    compareMethods: (owner: string, repo: string) => Promise<void>;
  }
}

export async function testGitHubOptimized() {
  console.log('🧪 Testing GitHub Optimized Service...');
  
  const optimizedService = GitHubOptimizedService.getInstance();
  
  try {
    // Test 1: Check repository access
    console.log('1. Testing repository access...');
    const isAccessible = await optimizedService.checkRepositoryAccess('facebook', 'react');
    console.log('✅ Repository accessible:', isAccessible);
    
    // Test 2: Estimate repository size
    console.log('2. Testing repository size estimation...');
    const sizeKB = await optimizedService.estimateRepositorySize('facebook', 'react');
    console.log('✅ Estimated size:', `${(sizeKB / 1024).toFixed(2)}MB`);
    
    // Test 3: Get branches
    console.log('3. Testing branch fetching...');
    const branches = await optimizedService.getBranches('facebook', 'react');
    console.log('✅ Available branches:', branches);
    
    // Test 4: Performance comparison
    console.log('4. Testing performance comparison...');
    const comparison = await optimizedService.comparePerformance('facebook', 'react');
    console.log('✅ Performance comparison:', comparison);
    
    // Test 5: Download small repository with optimization
    console.log('5. Testing optimized download (small repo)...');
    const progressCallback = (progress: any) => {
      console.log(`📊 Progress: ${progress.stage} - ${progress.progress}% - ${progress.message}`);
    };
    
    const result = await optimizedService.getRepositoryStructure(
      'octocat', 
      'Hello-World', 
      'main',
      {
        batchSize: 10,
        maxConcurrent: 3,
        enableCaching: true
      },
      progressCallback
    );
    
    console.log('✅ Optimized processing completed:', {
      fileCount: result.fileContents.size,
      pathsCount: result.allPaths.length
    });
    
    console.log('🎉 All GitHub Optimized tests passed!');
    
  } catch (error) {
    console.error('❌ GitHub Optimized test failed:', error);
  }
}

export async function testHybridGitHub() {
  console.log('🧪 Testing Hybrid GitHub Service...');
  
  const hybridService = HybridGitHubService.getInstance();
  
  try {
    // Test 1: Check repository access
    console.log('1. Testing repository access...');
    const isAccessible = await hybridService.checkRepositoryAccess('facebook', 'react');
    console.log('✅ Repository accessible:', isAccessible);
    
    // Test 2: Compare methods
    console.log('2. Testing method comparison...');
    const comparison = await hybridService.compareMethods('facebook', 'react');
    console.log('✅ Method comparison:', comparison);
    
    // Test 3: Get repository structure with hybrid service
    console.log('3. Testing hybrid repository processing...');
    const progressCallback = (progress: any) => {
      console.log(`📊 Progress: ${progress.method.toUpperCase()} - ${progress.stage} - ${progress.progress}% - ${progress.message}`);
    };
    
         const result = await hybridService.getRepositoryStructure(
       'octocat',
       'Hello-World',
       'main',
       {
         preferOptimized: true,
         maxConcurrent: 5,
         batchSize: 20,
         enableCaching: true
       },
       progressCallback
     );
    
    console.log('✅ Hybrid processing completed:', {
      fileCount: result.fileContents.size,
      pathsCount: result.allPaths.length
    });
    
    console.log('🎉 All Hybrid GitHub tests passed!');
    
  } catch (error) {
    console.error('❌ Hybrid GitHub test failed:', error);
  }
}

export async function compareMethods(owner: string, repo: string) {
  console.log(`🧪 Comparing methods for ${owner}/${repo}...`);
  
  const hybridService = HybridGitHubService.getInstance();
  
  try {
    const comparison = await hybridService.compareMethods(owner, repo);
    
         console.log('📊 Method Comparison Results:');
     console.log('Optimized Method:');
     console.log(`  - Estimated Time: ${comparison.optimized.estimatedTime.toFixed(1)}s`);
     console.log(`  - Estimated Calls: ${comparison.optimized.estimatedCalls}`);
     console.log('');
     console.log('Standard Method:');
     console.log(`  - Estimated Time: ${comparison.standard.estimatedTime.toFixed(1)}s`);
     console.log(`  - Estimated Calls: ${comparison.standard.estimatedCalls}`);
     console.log('');
     console.log(`🎯 Recommended Method: ${comparison.recommended.toUpperCase()}`);
    
  } catch (error) {
    console.error('❌ Method comparison failed:', error);
  }
}



// Expose functions globally for browser console testing
if (typeof window !== 'undefined') {
  window.testGitHubOptimized = testGitHubOptimized;
  window.testHybridGitHub = testHybridGitHub;
  window.compareMethods = compareMethods;
  
  console.log('🧪 GitHub Optimized test functions loaded:');
  console.log('- testGitHubOptimized() - Test optimized service');
  console.log('- testHybridGitHub() - Test hybrid service');
  console.log('- compareMethods("owner", "repo") - Compare methods for a repository');
}
