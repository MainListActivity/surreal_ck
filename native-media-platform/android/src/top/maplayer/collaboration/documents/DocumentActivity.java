package top.maplayer.collaboration.documents;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;

/** Private transient activity: delegates consent to the OS document UI; never overwrites via paths. */
public final class DocumentActivity extends Activity {
    private long request;
    private String source;
    private final DocumentLifetime lifetime = new DocumentLifetime();
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        request = getIntent().getLongExtra("request", 0);
        source = getIntent().getStringExtra("source");
        if (request <= 0) { finish(); return; }
        if (saved != null) return; // The OS delivers the outstanding result after recreation.
        Intent pick = new Intent(source == null ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_CREATE_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("application/octet-stream");
        if (source == null) pick.setType("*/*");
        else pick.putExtra(Intent.EXTRA_TITLE, new File(source).getName());
        try { launch(pick); }
        catch (RuntimeException error) { DocumentBridge.finish(request, "failed", "", error.toString()); finish(); }
    }
    @SuppressWarnings("deprecation")
    private void launch(Intent intent) { startActivityForResult(intent, 1); }
    @Override @SuppressWarnings("deprecation")
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != 1 || !lifetime.acceptResult()) return;
        if (result != RESULT_OK || data == null || data.getData() == null) {
            DocumentBridge.finish(request, "cancelled", "", ""); finish(); return;
        }
        Uri uri = data.getData();
        if (!"content".equals(uri.getScheme())) {
            DocumentBridge.finish(request, "failed", "", "Document provider did not return a content URI"); finish(); return;
        }
        // Do not hold Activity/its UI thread while reading potentially remote providers.
        android.content.Context context = getApplicationContext();
        long id = request;
        String export = source;
        new Thread(() -> {
            File staged = null;
            try {
                if (export == null) {
                    File directory = new File(context.getCacheDir(), "saf-imports").getCanonicalFile();
                    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create private import directory");
                    DocumentBridge.reserveImport(directory);
                    File selection = new File(directory, java.util.UUID.randomUUID().toString());
                    if (!selection.mkdir()) throw new IOException("Cannot create selection directory");
                    staged = new File(selection, displayName(context, uri));
                    if (!staged.createNewFile()) throw new IOException("Import destination exists");
                    try (InputStream input = context.getContentResolver().openInputStream(uri);
                         FileOutputStream output = new FileOutputStream(staged)) {
                        copy(input, output); output.getFD().sync();
                    }
                    DocumentBridge.finish(id, "imported", staged.getPath(), "Private copy; not sent");
                } else {
                    File file = new File(export).getCanonicalFile();
                    if (!file.getPath().startsWith(context.getFilesDir().getCanonicalPath() + File.separator)
                            || !file.isFile() || file.length() > DocumentBridge.MAX_BYTES) throw new IOException("Invalid private export source");
                    try (InputStream input = new FileInputStream(file);
                         OutputStream output = context.getContentResolver().openOutputStream(uri, "w")) {
                        copy(input, output);
                    }
                    DocumentBridge.finish(id, "exported", "", "Provider stream closed; transfer source retained");
                }
            } catch (IOException | RuntimeException error) {
                if (staged != null) {
                    try { DocumentBridge.release(context, staged.getPath()); }
                    catch (IOException cleanup) { android.util.Log.w("CKDocuments", "Could not remove failed private import"); }
                }
                DocumentBridge.finish(id, "failed", "", error.toString() + (export == null ? "" : "; the selected destination may contain a partial file"));
            }
        }, "ck-documents").start();
        finish();
    }
    @Override protected void onDestroy() {
        if (lifetime.cancelOnDestroy(isChangingConfigurations())) {
            DocumentBridge.finish(request, "cancelled", "", "Document window closed before a selection result");
        }
        super.onDestroy();
    }
    private static String displayName(android.content.Context context, Uri uri) {
        try (android.database.Cursor cursor = context.getContentResolver().query(uri,
                new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty() && name.length() <= 128
                        && !name.equals(".") && !name.equals("..")
                        && name.indexOf('/') < 0 && name.indexOf('\\') < 0
                        && name.codePoints().noneMatch(Character::isISOControl)) return name;
            }
        } catch (RuntimeException error) { android.util.Log.w("CKDocuments", "Provider name unavailable"); }
        return "selected-file.bin";
    }
    private static void copy(InputStream input, OutputStream output) throws IOException {
        if (input == null || output == null) throw new IOException("Provider did not open a stream");
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        for (int count; (count = input.read(buffer)) != -1;) {
            total += count;
            if (total > DocumentBridge.MAX_BYTES) throw new IOException("File exceeds 256 MiB limit; destination may contain a partial file");
            output.write(buffer, 0, count);
        }
        output.flush();
    }
}
