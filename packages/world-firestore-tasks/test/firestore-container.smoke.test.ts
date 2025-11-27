import { Firestore } from '@google-cloud/firestore';
import type { StartedFirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { FirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('Firestore Container Smoke Test', () => {
  let container: StartedFirestoreEmulatorContainer;
  let firestore: Firestore;
  let startupTime: number;

  beforeAll(async () => {
    console.log('[Smoke Test] Starting Firestore emulator container...');
    const startTime = Date.now();

    // Use official FirestoreEmulatorContainer API with Docker image
    container = await new FirestoreEmulatorContainer(
      'gcr.io/google.com/cloudsdktool/google-cloud-cli:441.0.0-emulators'
    ).start();

    startupTime = Date.now() - startTime;
    console.log(
      `[Smoke Test] Container started in ${startupTime}ms (${(startupTime / 1000).toFixed(2)}s)`
    );
    console.log(
      `[Smoke Test] Emulator endpoint: ${container.getEmulatorEndpoint()}`
    );

    // Create Firestore client using container's endpoint
    firestore = new Firestore({
      host: container.getEmulatorEndpoint(),
      ssl: false,
      projectId: 'test-project',
      customHeaders: {
        Authorization: 'Bearer owner',
      },
    });

    firestore.settings({
      ignoreUndefinedProperties: true,
    });

    console.log('[Smoke Test] Firestore client configured');
  }, 300_000); // 5 minute timeout

  afterAll(async () => {
    console.log('[Smoke Test] Stopping container...');
    await container?.stop();
  });

  it('should start container successfully', () => {
    expect(container).toBeDefined();
    expect(container.getEmulatorEndpoint()).toBeTruthy();
    console.log(`[Smoke Test] ✓ Container startup time: ${startupTime}ms`);
  });

  it('should connect to Firestore emulator', async () => {
    expect(firestore).toBeDefined();

    // Try to list collections (should be empty initially)
    const collections = await firestore.listCollections();
    expect(collections).toBeInstanceOf(Array);
    console.log(
      `[Smoke Test] ✓ Connected to Firestore, found ${collections.length} collections`
    );
  });

  it('should perform basic CRUD operations', async () => {
    const collectionName = 'smoke_test';
    const docId = 'test-doc-1';

    // Create a document
    await firestore.collection(collectionName).doc(docId).set({
      name: 'Smoke Test',
      timestamp: new Date(),
      value: 42,
    });

    // Read the document
    const doc = await firestore.collection(collectionName).doc(docId).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.name).toBe('Smoke Test');
    expect(doc.data()?.value).toBe(42);

    // Update the document
    await firestore.collection(collectionName).doc(docId).update({
      value: 100,
    });

    const updatedDoc = await firestore
      .collection(collectionName)
      .doc(docId)
      .get();
    expect(updatedDoc.data()?.value).toBe(100);

    // Delete the document
    await firestore.collection(collectionName).doc(docId).delete();

    const deletedDoc = await firestore
      .collection(collectionName)
      .doc(docId)
      .get();
    expect(deletedDoc.exists).toBe(false);

    console.log('[Smoke Test] ✓ CRUD operations successful');
  });

  it('should support subcollections', async () => {
    const parentDoc = firestore.collection('parents').doc('parent-1');
    await parentDoc.set({ name: 'Parent Document' });

    // Create subcollection
    await parentDoc.collection('children').doc('child-1').set({
      name: 'Child Document',
      value: 123,
    });

    // Read from subcollection
    const childDoc = await parentDoc
      .collection('children')
      .doc('child-1')
      .get();
    expect(childDoc.exists).toBe(true);
    expect(childDoc.data()?.name).toBe('Child Document');

    console.log('[Smoke Test] ✓ Subcollections working');
  });

  it('should support collection group queries', async () => {
    // Create documents in multiple parent paths with same subcollection name
    await firestore
      .collection('users')
      .doc('user1')
      .collection('items')
      .doc('item1')
      .set({
        type: 'global-item',
        value: 1,
      });

    await firestore
      .collection('users')
      .doc('user2')
      .collection('items')
      .doc('item2')
      .set({
        type: 'global-item',
        value: 2,
      });

    // Query across all 'items' subcollections
    const snapshot = await firestore
      .collectionGroup('items')
      .where('type', '==', 'global-item')
      .get();

    expect(snapshot.docs.length).toBe(2);
    console.log('[Smoke Test] ✓ Collection group queries working');
  });
});
