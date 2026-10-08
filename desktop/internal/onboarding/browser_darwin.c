#include <CoreFoundation/CoreFoundation.h>
#include <CoreServices/CoreServices.h>
#include <stdlib.h>

static char *rechiv_copy_utf8(CFStringRef value) {
	if (value == NULL) {
		return NULL;
	}
	CFIndex size = CFStringGetMaximumSizeForEncoding(
		CFStringGetLength(value), kCFStringEncodingUTF8) + 1;
	char *result = malloc((size_t)size);
	if (result == NULL) {
		return NULL;
	}
	if (!CFStringGetCString(value, result, size, kCFStringEncodingUTF8)) {
		free(result);
		return NULL;
	}
	return result;
}

char *rechiv_default_https_bundle_id(void) {
	#pragma clang diagnostic push
	#pragma clang diagnostic ignored "-Wdeprecated-declarations"
	CFStringRef bundle_id = LSCopyDefaultHandlerForURLScheme(CFSTR("https"));
	#pragma clang diagnostic pop
	if (bundle_id == NULL) {
		return NULL;
	}
	char *result = rechiv_copy_utf8(bundle_id);
	CFRelease(bundle_id);
	return result;
}

int rechiv_application_for_bundle_id(const char *bundle_id, char **name, char **path) {
	CFStringRef identifier = CFStringCreateWithCString(
		kCFAllocatorDefault, bundle_id, kCFStringEncodingUTF8);
	if (identifier == NULL) {
		return 0;
	}
	CFErrorRef error = NULL;
	CFArrayRef applications = LSCopyApplicationURLsForBundleIdentifier(identifier, &error);
	CFRelease(identifier);
	if (error != NULL) {
		CFRelease(error);
	}
	if (applications == NULL || CFArrayGetCount(applications) == 0) {
		if (applications != NULL) {
			CFRelease(applications);
		}
		return 0;
	}

	CFURLRef application_url = (CFURLRef)CFArrayGetValueAtIndex(applications, 0);
	CFStringRef application_path = CFURLCopyFileSystemPath(
		application_url, kCFURLPOSIXPathStyle);
	CFStringRef filename = CFURLCopyLastPathComponent(application_url);
	CFStringRef display_name = filename == NULL ? NULL :
		CFStringCreateCopy(kCFAllocatorDefault, filename);
	if (display_name != NULL && CFStringHasSuffix(display_name, CFSTR(".app"))) {
		CFMutableStringRef mutable_name = CFStringCreateMutableCopy(
			kCFAllocatorDefault, 0, display_name);
		if (mutable_name != NULL) {
			CFRelease(display_name);
			display_name = mutable_name;
			CFStringDelete(mutable_name,
				CFRangeMake(CFStringGetLength(mutable_name) - 4, 4));
		}
	}

	*name = rechiv_copy_utf8(display_name);
	*path = rechiv_copy_utf8(application_path);
	if (display_name != NULL) {
		CFRelease(display_name);
	}
	if (filename != NULL) {
		CFRelease(filename);
	}
	if (application_path != NULL) {
		CFRelease(application_path);
	}
	CFRelease(applications);
	if (*name == NULL || *path == NULL) {
		free(*name);
		free(*path);
		*name = NULL;
		*path = NULL;
		return 0;
	}
	return 1;
}
